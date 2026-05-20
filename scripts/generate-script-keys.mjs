import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.cwd();
const secretsDir = path.join(root, "server", "secrets");
fs.mkdirSync(secretsDir, { recursive: true });

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

const privatePath = path.join(secretsDir, "script_sign_private.pem");
const publicPath = path.join(secretsDir, "script_verify_public.pem");
fs.writeFileSync(privatePath, privateKey, { mode: 0o600 });
fs.writeFileSync(publicPath, publicKey, { mode: 0o644 });

const privateOneLine = privateKey.trim().replace(/\r?\n/g, "\\n");
const publicOneLine = publicKey.trim().replace(/\r?\n/g, "\\n");

const privateEnvPath = path.join(root, "server", "script_sign_private_env.txt");
const publicEnvPath = path.join(root, "server", "script_verify_public_env.txt");
fs.writeFileSync(privateEnvPath, `SCRIPT_SIGN_PRIVATE_KEY=${privateOneLine}\n`);
fs.writeFileSync(publicEnvPath, `SCRIPT_VERIFY_PUBLIC_KEY=${publicOneLine}\n`);

const gradlePropertiesPath = path.join(root, "gradle.properties");
const gradleLines = fs
  .readFileSync(gradlePropertiesPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => !line.startsWith("SCRIPT_VERIFY_PUBLIC_KEY="));
gradleLines.push(`SCRIPT_VERIFY_PUBLIC_KEY=${publicOneLine}`);
fs.writeFileSync(gradlePropertiesPath, `${gradleLines.join("\n")}\n`);

console.log("generated");
console.log(privatePath);
console.log(publicPath);
console.log(privateEnvPath);
console.log(publicEnvPath);
