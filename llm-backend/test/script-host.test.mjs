/**
 * 共享执行契约（script_host.js）测试
 *
 * 这份测试同时保障设备端 QuickJS 与服务端 Node 沙箱的行为：
 * 两端都通过 __dawnHost.begin() / resultJson() 驱动脚本，因此这里的用例
 * 直接锁定了「服务端跑通 == 设备端跑通」这一核心约束。
 *
 * 驱动方式刻意与设备端保持一致（在上下文内用字符串求值调用），
 * 以便同时验证 QuickJS 侧的调用约定。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const HARNESS_SOURCE = fs.readFileSync(
  new URL("../../html/scripts/runtime/script_host.js", import.meta.url),
  "utf8"
);

/** 创建一个隔离上下文，装载 harness 与被测脚本 */
function createHost(scriptSource) {
  const context = vm.createContext({});
  vm.runInContext(HARNESS_SOURCE, context);
  if (scriptSource) vm.runInContext(scriptSource, context);
  return context;
}

/** 以设备端相同的方式驱动一次执行，返回 { pending, result } */
function begin(context, input, options = {}) {
  const pending = vm.runInContext(
    `__dawnHost.begin(globalThis, ${JSON.stringify(input)}, ${JSON.stringify(options)})`,
    context
  );
  const raw = vm.runInContext("__dawnHost.resultJson()", context);
  return { pending, result: raw ? JSON.parse(raw) : null };
}

/** 异步脚本：等待结算后取结果 */
async function settle(context) {
  await vm.runInContext("__dawnHost.settled()", context);
  const raw = vm.runInContext("__dawnHost.resultJson()", context);
  return raw ? JSON.parse(raw) : null;
}

const DAWN_COURSE = {
  name: "高等数学",
  teacher: "张三",
  location: "A101",
  dayOfWeek: 1,
  startSection: 1,
  duration: 2,
  startWeek: 1,
  endWeek: 16,
  weekType: 0
};

const XIAOAI_COURSE = {
  name: "大学物理",
  teacher: "李四",
  position: "B202",
  day: 3,
  weeks: [1, 2, 3, 4, 5],
  sections: [3, 4]
};

test("解析器返回 Dawn 原生结构时判定通过", () => {
  const context = createHost(`
    function scheduleHtmlParser(html) {
      return JSON.stringify([${JSON.stringify(DAWN_COURSE)}]);
    }
  `);

  const { pending, result } = begin(context, "<html></html>");

  assert.equal(pending, false);
  assert.equal(result.ok, true);
  assert.equal(result.status, "passed");
  assert.equal(result.schemaValid, true);
  assert.equal(result.resultCount, 1);
  assert.equal(result.entryUsed, "scheduleHtmlParser");
  assert.equal(result.errorCode, "");
});

test("解析器返回小爱结构时同样判定通过", () => {
  // 回归用例：服务端旧实现只认 Dawn 原生字段，会把合法的小爱格式
  // （离散 weeks / sections 数组）误判为 schema_invalid，导致自愈流程
  // 把本来正确的脚本判为失败。
  const context = createHost(`
    function scheduleHtmlParser(html) {
      return JSON.stringify({ courses: [${JSON.stringify(XIAOAI_COURSE)}] });
    }
  `);

  const { result } = begin(context, "<html></html>");

  assert.equal(result.ok, true);
  assert.equal(result.schemaValid, true);
  assert.equal(result.resultCount, 1);
});

test("provider 链的最终结果取 provider 返回值并合并 timetable", () => {
  // 小爱生态约定：provider 产出数据，parser/timer 仅转发。
  // 因此最终结果必须是 provider 的返回值，timer 的产物只补进 timetable 字段。
  const context = createHost(`
    function scheduleHtmlProvider(iframeContent, frameContent, dom) {
      return JSON.stringify({ courses: [${JSON.stringify(XIAOAI_COURSE)}] });
    }
    function scheduleHtmlParser(providerRes) {
      return "parser-should-not-win";
    }
    function scheduleTimer(payload) {
      return [{ section: 1, startTime: "08:00", endTime: "08:45" }];
    }
  `);

  const { result } = begin(context, "<html></html>");

  assert.equal(result.entryUsed, "scheduleHtmlProvider");
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.raw);
  assert.equal(payload.courses.length, 1);
  assert.equal(payload.timetable.length, 1, "timer 的产物应合并进 timetable");
});

test("provider 返回 Promise 时报告挂起并可异步结算", async () => {
  const context = createHost(`
    function scheduleHtmlProvider(iframeContent, frameContent, dom) {
      return Promise.resolve(JSON.stringify({ courses: [${JSON.stringify(XIAOAI_COURSE)}] }));
    }
  `);

  const { pending, result } = begin(context, "<html></html>");
  assert.equal(pending, true, "异步脚本应报告挂起，交由宿主泵微任务");
  assert.equal(result, null);

  const settled = await settle(context);
  assert.equal(settled.ok, true);
  assert.equal(settled.resultCount, 1);
});

test("do not continue 被识别为跳过信号而非失败", () => {
  const context = createHost(`
    function scheduleHtmlProvider() { return "do not continue"; }
  `);

  const { result } = begin(context, "<html></html>");

  assert.equal(result.errorCode, "do_not_continue");
  assert.equal(result.schemaValid, true, "跳过信号不应算作结构错误");
  assert.equal(result.ok, false);
});

test("缺少入口函数时返回 no_entry", () => {
  const context = createHost("var unrelated = 1;");

  const { result } = begin(context, "<html></html>");

  assert.equal(result.errorCode, "no_entry");
  assert.equal(result.status, "failed");
});

test("脚本抛出异常时返回 script_exception 且不泄露页面内容", () => {
  const context = createHost(`
    function scheduleHtmlParser(html) { throw new Error("boom"); }
  `);

  const { result } = begin(context, "<html>secret</html>");

  assert.equal(result.errorCode, "script_exception");
  assert.equal(result.errorMessage, "boom");
  assert.equal(result.raw, "", "失败时不应回传原始页面内容");
});

test("空结果与全非法结构分别归类", () => {
  const empty = createHost("function scheduleHtmlParser() { return JSON.stringify([]); }");
  assert.equal(begin(empty, "x").result.errorCode, "empty_result");

  const invalid = createHost(`
    function scheduleHtmlParser() {
      return JSON.stringify([{ name: "缺字段的课", dayOfWeek: 1 }]);
    }
  `);
  assert.equal(begin(invalid, "x").result.errorCode, "schema_invalid");
});

test("仅提供 courseName 别名的输出被判为非法", () => {
  // 设备端 parseParsedCourseArray 只读 name 字段。服务端旧实现额外接受
  // courseName / title 别名，会放行「沙箱通过但设备端解析出 0 门课」的脚本，
  // 因此这里以设备端为事实标准，明确不接受别名。
  const context = createHost(`
    function scheduleHtmlParser() {
      return JSON.stringify([{
        courseName: "只有别名的课", dayOfWeek: 1, startSection: 1,
        duration: 2, startWeek: 1, endWeek: 16
      }]);
    }
  `);

  const { result } = begin(context, "x");

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "schema_invalid");
});

test("重复率过高的退化输出被拦截", () => {
  const context = createHost(`
    function scheduleHtmlParser() {
      var one = ${JSON.stringify(DAWN_COURSE)};
      return JSON.stringify([one, one, one, one, one]);
    }
  `);

  const { result } = begin(context, "x");

  assert.equal(result.errorCode, "duplicate_ratio_high");
  assert.equal(result.ok, false);
});

test("支持嵌套包装结构的解包", () => {
  const context = createHost(`
    function parse() {
      return { data: { courses: [${JSON.stringify(DAWN_COURSE)}] } };
    }
  `);

  const { result } = begin(context, "x");

  assert.equal(result.ok, true);
  assert.equal(result.entryUsed, "parse");
  assert.equal(result.resultCount, 1);
});

test("显式 entry 优先于默认探测顺序", () => {
  const context = createHost(`
    function scheduleHtmlParser() { return JSON.stringify([]); }
    function customEntry() { return JSON.stringify([${JSON.stringify(DAWN_COURSE)}]); }
  `);

  const { result } = begin(context, "x", { entry: "customEntry" });

  assert.equal(result.entryUsed, "customEntry");
  assert.equal(result.ok, true);
});

test("学期提取与导航结果按各自口径校验", () => {
  const term = createHost(`
    function extractTermOptions() {
      return { terms: [{ label: "2025-2026学年", value: "2025" }] };
    }
  `);
  assert.equal(begin(term, "x", { targetType: "term_extractor" }).result.ok, true);

  const navigation = createHost(`
    function navigateToSchedule() {
      return { action: "navigate", url: "/jsxsd/xskb/xskb_list.do" };
    }
  `);
  assert.equal(begin(navigation, "x", { targetType: "navigation" }).result.ok, true);
});

test("超时预算可被宿主判定并强制结算", () => {
  const context = createHost(`
    function scheduleHtmlProvider() { return new Promise(function () {}); }
  `);

  const { pending } = begin(context, "x", { deadlineAt: Date.now() - 1 });
  assert.equal(pending, true);

  assert.equal(vm.runInContext("__dawnHost.isExpired()", context), true);
  vm.runInContext("__dawnHost.abortAsTimeout('scheduleHtmlProvider')", context);

  const result = JSON.parse(vm.runInContext("__dawnHost.resultJson()", context));
  assert.equal(result.errorCode, "timeout");
  assert.equal(result.status, "timeout");
});

test("契约版本号对外暴露以供客户端门控", () => {
  const context = createHost("");
  assert.equal(vm.runInContext("__dawnHost.CONTRACT_VERSION", context), 1);
});

test("设备端内置副本与服务端权威源保持一致", () => {
  // harness 在两处各存一份：server/html/scripts/runtime（权威源，可热更下发）
  // 与 app/src/main/assets/runtime（断网兜底）。两者漂移会让「服务端跑通 == 设备跑通」
  // 的前提失效，因此在此锁定一致性。
  //
  // server/ 目录会被 sync-server-repo 工作流同步到独立仓库，那里不存在 app 副本，
  // 因此副本缺失时跳过而非失败。
  const appCopyUrl = new URL("../../../app/src/main/assets/runtime/script_host.js", import.meta.url);
  if (!fs.existsSync(appCopyUrl)) return;

  const appCopy = fs.readFileSync(appCopyUrl, "utf8");
  assert.equal(
    appCopy.replace(/\r\n/g, "\n"),
    HARNESS_SOURCE.replace(/\r\n/g, "\n"),
    "app/src/main/assets/runtime/script_host.js 与服务端权威源不一致，请同步后再提交"
  );
});
