export function readOptions(env: NodeJS.ProcessEnv = process.env) {
  const port = env.OPERATOR_PORT ?? '3000';
  if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('OPERATOR_PORT must be an integer between 1 and 65535');
  }

  let replicatorUrl: string | undefined;
  if (env.REPLICATOR_API_URL) {
    const url = new URL(env.REPLICATOR_API_URL);
    const http = url.protocol === 'http:' || url.protocol === 'https:';
    if (!http || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('REPLICATOR_API_URL must be an HTTP(S) origin without credentials or a path');
    }
    replicatorUrl = url.origin;
  }

  return {
    port: Number(port),
    host: env.OPERATOR_HOST ?? '127.0.0.1',
    replicatorUrl,
  };
}
