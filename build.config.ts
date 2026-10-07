import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [{ type: "bundle", input: ["src/index.mts", "src/upload.mts", "src/promote.mts"] }],
});
