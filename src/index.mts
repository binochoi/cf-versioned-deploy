import { parseEnv } from "node:util";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

type Env = Record<string, string | undefined>;

export function readEnv(path: string): Env {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    // .env 없음 — 빈 환경으로 취급(값 없는 var/secret 은 아래서 건너뜀).
    return {};
  }
}

// "POSTHOG_KEY=VITE_PUBLIC_POSTHOG_KEY" 스펙을 .env 값으로 풀어 wrangler `--var NAME:value`
// 인자로 만든다. .env 에 값이 없으면 경고만 하고 건너뛴다(일부 값이 빠진 로컬 .env 로도 배포되게).
export function resolveVarArgs(env: Env, specs: string[]): string[] {
  const args: string[] = [];
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq === -1) {
      throw new Error(`--var-from-env 형식 오류(NAME=ENV_KEY 여야 함): ${spec}`);
    }
    const name = spec.slice(0, eq);
    const envKey = spec.slice(eq + 1);
    const value = env[envKey];
    if (!value) {
      process.stderr.write(
        `[cf-upload] .env 에 ${envKey} 없음 — --var ${name} 생략(빈 값으로 배포)\n`,
      );
      continue;
    }
    args.push("--var", `${name}:${value}`);
  }
  return args;
}

// 지정 키들을 .env 에서 모아 임시 JSON 시크릿 파일로 쓴다(wrangler `--secrets-file` 용).
// 값이 하나도 없으면 null 을 반환한다(파일 안 만듦). 반환된 경로는 호출측이 지운다.
export function writeSecretsFile(env: Env, keys: string[]): string | null {
  const toSync: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const value = env[key];
    if (value) toSync[key] = value;
    else missing.push(key);
  }
  if (missing.length > 0) {
    process.stderr.write(`[cf-upload] .env 에 값 없어 시크릿 생략: ${missing.join(", ")}\n`);
  }
  if (Object.keys(toSync).length === 0) return null;

  const path = join(tmpdir(), `cf-versioned-secrets-${process.pid}.json`);
  writeFileSync(path, JSON.stringify(toSync), { mode: 0o600 });
  return path;
}

const VERSION_ID_RE = /Version ID:\s*([0-9a-f-]{36})/i;

export interface UploadOptions {
  tag?: string;
  message?: string;
  varFromEnv: string[];
  secrets: string[];
  envPath: string;
  idFile: string;
}

export function uploadVersion(opts: UploadOptions): void {
  const env = readEnv(opts.envPath);
  const args = ["wrangler", "versions", "upload"];
  if (opts.tag) args.push("--tag", opts.tag);
  if (opts.message) args.push("--message", opts.message);
  args.push(...resolveVarArgs(env, opts.varFromEnv));

  const secretsFile = opts.secrets.length > 0 ? writeSecretsFile(env, opts.secrets) : null;
  if (secretsFile) args.push("--secrets-file", secretsFile);

  try {
    // stdout 은 파싱을 위해 캡처하고, stderr(진행/에러 로그)는 그대로 흘려보낸다.
    const result = spawnSync("npx", args, {
      stdio: ["inherit", "pipe", "inherit"],
      encoding: "utf8",
    });
    const stdout = result.stdout ?? "";
    process.stdout.write(stdout); // 캡처한 로그를 다시 보여준다.
    if (result.status !== 0) {
      process.stderr.write("[cf-upload] wrangler versions upload 실패\n");
      process.exit(result.status ?? 1);
    }
    const match = VERSION_ID_RE.exec(stdout);
    if (!match) {
      process.stderr.write(
        "[cf-upload] 업로드 출력에서 Version ID 를 못 찾음 — promote 불가\n",
      );
      process.exit(1);
    }
    writeFileSync(opts.idFile, match[1], "utf8");
    process.stdout.write(`[cf-upload] version id → ${opts.idFile}: ${match[1]}\n`);
  } finally {
    if (secretsFile) unlinkSync(secretsFile);
  }
}

export interface PromoteOptions {
  idFile: string;
  message?: string;
}

/**
 * versioned 배포(`wrangler versions upload`/`versions deploy`)는 Cron Trigger 를 등록하지
 * 않는다 — 트리거는 버전이 아니라 스크립트 레벨 설정이라 versions 경로가 아예 안 건드린다.
 * 그래서 promote 성공 직후 cwd 의 wrangler.jsonc 에서 crons 를 읽어, 있으면 `wrangler
 * triggers deploy` 로 라이브 워커에 별도 반영한다. 이 동기화가 없으면 wrangler.jsonc 에
 * crons 를 적어도 배포된 워커엔 영영 안 붙어 예약 작업이 조용히 멈춘다. versioned 경로는
 * prod(top-level) 전용이므로 env-scope(env.<name>.triggers)는 보지 않고 top-level
 * triggers.crons 만 본다.
 *
 * @returns 프로세스 종료 코드(0=성공/스킵). 실패는 조용히 넘기지 않고 그 status 로 표면화.
 */
function syncTriggersFromConfig(cwd: string): number {
  const configPath = ["wrangler.jsonc", "wrangler.json"]
    .map((f) => join(cwd, f))
    .find((p) => existsSync(p));
  if (!configPath) {
    // 이 툴은 jsonc 만 읽는다(wrangler.toml 은 미지원). toml 워커의 crons 는 직접
    // `wrangler triggers deploy` 로 반영해야 한다.
    process.stdout.write("[cf-promote] wrangler.jsonc 없음 — 트리거 동기화 스킵\n");
    return 0;
  }
  const config = parseJsonc(readFileSync(configPath, "utf8")) ?? {};
  const crons: unknown = config?.triggers?.crons;
  if (!Array.isArray(crons) || crons.length === 0) {
    process.stdout.write("[cf-promote] triggers.crons 없음 — 트리거 동기화 스킵\n");
    return 0;
  }
  // `wrangler triggers deploy` 는 assets.directory 존재를 검증하는데, promote 하는 환경엔
  // 빌드 산출물이 없을 수 있다. 트리거 배포는 자산을 업로드하지 않으므로 빈 디렉토리로 검증만
  // 통과시키면 된다.
  const assetsDir: unknown = config?.assets?.directory;
  if (typeof assetsDir === "string" && assetsDir) {
    mkdirSync(resolve(cwd, assetsDir), { recursive: true });
  }
  process.stdout.write(`[cf-promote] triggers.crons 동기화: ${JSON.stringify(crons)}\n`);
  // --env= 는 top-level(prod) 환경을 명시한다(멀티 env 가 정의돼 있으면 wrangler 가 대상
  // 지정을 요구하기 때문 — 빈 값이 곧 top-level).
  const result = spawnSync("npx", ["wrangler", "triggers", "deploy", "--env="], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write("[cf-promote] wrangler triggers deploy 실패\n");
  }
  return result.status ?? 1;
}

export function promoteVersion(opts: PromoteOptions): void {
  let id: string;
  try {
    id = readFileSync(opts.idFile, "utf8").trim();
  } catch {
    process.stderr.write(
      `[cf-promote] ${opts.idFile} 없음 — 먼저 cf-versions-upload 를 실행해야 함\n`,
    );
    process.exit(1);
  }
  if (!id) {
    process.stderr.write(`[cf-promote] ${opts.idFile} 가 비어 있음\n`);
    process.exit(1);
  }

  const args = ["wrangler", "versions", "deploy", `${id}@100%`, "-y"];
  if (opts.message) args.push("--message", opts.message);
  const result = spawnSync("npx", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  // promote 성공 → versioned 배포가 빠뜨리는 Cron Trigger 를 config 에서 동기화한다.
  process.exit(syncTriggersFromConfig(process.cwd()));
}
