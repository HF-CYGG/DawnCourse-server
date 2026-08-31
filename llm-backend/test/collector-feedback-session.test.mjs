import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerCollectorRoutes } from "../dist/collector.js";

test("script_feedback 优先 canonical importSessionId，审计新写不含 legacy 或 profile", async () => {
  const app = Fastify();
  const reports = [];
  const feedbackStats = [];
  await registerCollectorRoutes(app, {
    ingestParseReport: async (body, source) => {
      reports.push({ body, source });
      return { issueId: "issue-feedback", repairDomain: "PARSER", targetType: "parser", queued: false };
    },
    writeFeedbackStats: async (body) => {
      feedbackStats.push(body);
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/script_feedback",
    payload: {
      isSessionFinal: true,
      finalResult: "failed",
      importSessionId: "import-feedback",
      parseSessionId: "legacy-must-lose",
      profileId: "local-profile-must-not-leak",
      scriptName: "parser.js"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].source, "script_feedback");
  assert.equal(reports[0].body.session.importSessionId, "import-feedback");
  assert.equal(Object.hasOwn(reports[0].body.session, "parseSessionId"), false);
  assert.equal(Object.hasOwn(reports[0].body.session, "profileId"), false);
  assert.equal(feedbackStats.length, 1);
  assert.equal(feedbackStats[0].importSessionId, "import-feedback");
  assert.equal(Object.hasOwn(feedbackStats[0], "parseSessionId"), false);
  assert.equal(Object.hasOwn(feedbackStats[0], "profileId"), false);
  assert.equal(JSON.stringify(response.json()).includes("profileId"), false);

  const legacyResponse = await app.inject({
    method: "POST",
    url: "/api/v1/script_feedback",
    payload: {
      isSessionFinal: true,
      finalResult: "failed",
      parseSessionId: "legacy-feedback",
      scriptName: "parser.js"
    }
  });

  assert.equal(legacyResponse.statusCode, 200);
  assert.equal(reports[1].body.session.importSessionId, "legacy-feedback");
  assert.equal(Object.hasOwn(reports[1].body.session, "parseSessionId"), false);
  assert.equal(feedbackStats[1].importSessionId, "legacy-feedback");

  await app.close();
});
