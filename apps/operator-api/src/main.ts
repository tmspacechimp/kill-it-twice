import { createApp } from './app.js';
import { readOptions } from './options.js';
import { ProcessControlService, readComposeOptions } from './process-control.service.js';

async function bootstrap(): Promise<void> {
  const options = readOptions();
  const app = await createApp(
    options.replicatorUrl,
    new ProcessControlService(readComposeOptions()),
  );
  await app.listen(options.port, options.host);
  console.log(`Operator API listening on ${await app.getUrl()}`);
}

bootstrap().catch((error: unknown) => {
  console.error('Operator API failed', error);
  process.exitCode = 1;
});
