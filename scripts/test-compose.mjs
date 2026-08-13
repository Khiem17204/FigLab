import { spawnSync } from "node:child_process";

const result = spawnSync("docker", ["compose", "-f", "deploy/docker-compose.yml", "config"], {
  encoding: "utf8",
  stdio: "inherit",
});

process.exit(result.status ?? 1);
