import { trigger } from "./cron-shared.mts";

/** Schedule is declared in netlify.toml so all four sit in one place. */
export default async () => {
  await trigger("briefing");
};
