#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { uploadVersion } from "./index.mts";

const USAGE = `사용법: cf-versions-upload [옵션]

wrangler versions upload 로 (라이브 아닌) 새 버전을 올리고, 출력에서 Version ID 를
파싱해 파일(기본 .deploy-version-id)에 저장한다. 이후 cf-versions-promote 가 읽어 배포.

--tag/--message 는 생략 시 환경변수 CF_VERSION_TAG/CF_VERSION_MESSAGE 를 쓴다. CI 는
워커마다 같은 태그를 붙이도록 이 env 만 세팅하면 되고, 로컬에서는 둘 다 비면 태그 없이 올린다.

옵션:
  --tag <t>               버전 태그(예: 브랜치명, 기본 $CF_VERSION_TAG)
  --message <m>           버전 메시지(기본 $CF_VERSION_MESSAGE)
  --var-from-env NAME=KEY .env 의 KEY 값을 --var NAME:<값> 으로 주입(반복 가능, 없으면 생략)
  --secret KEY            .env 의 KEY 를 --secrets-file 로 버전에 포함(반복 가능, 없으면 생략)
  --env <path>            .env 경로(기본 .env)
  --id-file <path>        Version ID 저장 경로(기본 .deploy-version-id)
  -h, --help              이 도움말`;

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    message: { type: "string" },
    "var-from-env": { type: "string", multiple: true, default: [] },
    secret: { type: "string", multiple: true, default: [] },
    env: { type: "string", default: ".env" },
    "id-file": { type: "string", default: ".deploy-version-id" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

uploadVersion({
  tag: values.tag ?? process.env.CF_VERSION_TAG ?? undefined,
  message: values.message ?? process.env.CF_VERSION_MESSAGE ?? undefined,
  varFromEnv: values["var-from-env"],
  secrets: values.secret,
  envPath: resolve(values.env),
  idFile: values["id-file"],
});
