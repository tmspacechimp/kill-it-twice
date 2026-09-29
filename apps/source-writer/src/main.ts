import pg from 'pg';
import { HELP, parseCommand } from './cli.js';
import { runCommand } from './commands.js';

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));

  if (command.name === 'help') {
    console.log(HELP);
    return;
  }

  const client = new pg.Client({ connectionTimeoutMillis: 5_000 });

  try {
    await client.connect();
    await runCommand(client, command);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
