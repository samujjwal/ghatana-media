import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runner = readFileSync(resolve(root, "scripts/test-media-wave2-platform-matrix.sh"), "utf8");

test("report parser scopes Gradle diagnostics to the final recovered attempt", () => {
  const start = runner.indexOf("def parse_attempts(log_text):");
  const end = runner.indexOf("\nroot = pathlib.Path(source)", start);
  assert.notEqual(start, -1, "attempt parser is present in the report generator");
  assert.notEqual(end, -1, "attempt parser has a bounded source block");

  const parser = runner.slice(start, end);
  const log = [
    "* What went wrong:",
    "> Execution failed for task ':generateProto'.",
    "Retrying once after correcting executable bits for cached Linux Gradle tools.",
    "> Task :services:media:modules:vision:vision-service:test FAILED",
    "* What went wrong:",
    "> There were failing tests.",
  ].join("\n");
  const output = execFileSync("python3", ["-c", `${parser}\nimport json, sys\nprint(json.dumps(parse_attempts(sys.stdin.read())))`], {
    input: log,
    encoding: "utf8",
  });
  const attempts = JSON.parse(output);
  assert.equal(attempts.length, 2);
  assert.match(attempts.at(-1), /There were failing tests/u);
  assert.doesNotMatch(attempts.at(-1), /generateProto/u);

  const reportCode = runner.slice(end, runner.indexOf("\nexecuted_tasks = {}", end));
  assert.match(reportCode, /final_attempt_log\.splitlines\(\)/gu);
  assert.equal([...reportCode.matchAll(/final_attempt_log\.splitlines\(\)/gu)].length, 2,
    "both failed task paths and What went wrong are read from the final attempt");
});
