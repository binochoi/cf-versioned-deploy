#!/usr/bin/env node
import { parseArgs } from "node:util";
import { promoteVersion } from "./index.mts";

const USAGE = `사용법: cf-versions-promote [옵션]

cf-versions-upload 가 저장한 Version ID 를 읽어 wrangler versions deploy <id>@100% 로
프로덕션에 100% 반영(promote)한다.

옵션:
  --id-file <path>  Version ID 파일 경로(기본 .deploy-version-id)
  --message <m>     배포 메시지(선택)
  -h, --help        이 도움말`;

const { values } = parseArgs({
  options: {
    "id-file": { type: "string", default: ".deploy-version-id" },
    message: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

promoteVersion({ idFile: values["id-file"], message: values.message });
