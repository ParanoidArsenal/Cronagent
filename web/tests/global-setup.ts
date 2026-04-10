import type { FullConfig } from '@playwright/test';

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 2000;

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL ?? 'http://localhost:3000';

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await fetch(baseURL);
      if (res.ok) {
        console.log(`Server ready at ${baseURL}`);
        return;
      }
    } catch {
      // Server not ready yet
    }

    if (i < MAX_RETRIES - 1) {
      console.log(`Waiting for server at ${baseURL}... (attempt ${i + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  throw new Error(
    `Server at ${baseURL} did not become ready after ${MAX_RETRIES} attempts. ` +
    `Make sure the docker-compose stack is running: docker compose up db web`
  );
}
