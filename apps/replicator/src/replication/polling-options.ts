export type PollingOptions = {
  intervalMs: number;
  maxEmptyPolls: number;
};

export function readPollingOptions(env: NodeJS.ProcessEnv = process.env): PollingOptions {
  return {
    intervalMs: readPositiveInteger('POLL_INTERVAL_MS', env.POLL_INTERVAL_MS ?? '1000'),
    maxEmptyPolls: readPositiveInteger('POLL_MAX_EMPTY', env.POLL_MAX_EMPTY ?? '3'),
  };
}

function readPositiveInteger(name: string, value: string): number {
  const number = Number(value);

  if (!/^\d+$/.test(value) || !Number.isInteger(number) || number < 1 || number > 2_147_483_647) {
    throw new Error(`${name} must be an integer from 1 to 2147483647`);
  }

  return number;
}
