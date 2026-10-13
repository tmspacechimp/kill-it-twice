import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { RunEvidence } from '../../logging/run-evidence.mjs';
import { VerificationEnvironment } from './environment.mjs';

// Both entry points use the same evidence, failure, and cleanup conventions.
export async function runScenario(name, readConfiguration, verifyScenario) {
  const run = new RunEvidence(`verify-${name.toLowerCase()}`);
  run.captureConsole();
  let environment;
  let result;
  let collecting = false;

  const interrupt = async (signal) => {
    run.timeline('verification interrupted', { signal });
    if (collecting) await cleanup(environment, run, name);
    run.finish('INTERRUPTED', { signal });
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onInterrupt = () => interrupt('SIGINT');
  const onTerminate = () => interrupt('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  try {
    if (existsSync('.env')) loadEnvFile('.env');
    loadEnvFile('.env.verify');
    const configuration = readConfiguration();
    environment = new VerificationEnvironment(
      `kill-it-twice-${name.toLowerCase()}-${randomUUID()}`,
      run,
      configuration,
    );
    run.summary.configuration = {
      projectName: environment.projectName,
      ...configuration,
      pollIntervalMs: 1000,
      pollMaxEmpty: 3,
    };
    if (configuration.crashEventIds) run.summary.evidence.crashSchedule = 'crash-schedule.json';
    run.saveSummary();
    run.startCollector(environment.projectName);
    collecting = true;
    result = await verifyScenario(environment, run, configuration);
  } catch (error) {
    process.exitCode = 1;
    run.save('validation/failure.json', {
      message: error.message,
      stack: error.stack,
      actual: error.actual,
      expected: error.expected,
    });
    run.timeline('verification failed', { message: error.message });
    console.error(`${name} FAIL:`, error);
    if (collecting) {
      try {
        console.error(environment.failureLogs());
      } catch (logError) {
        console.error('Could not collect container logs:', logError.message);
      }
    }
  } finally {
    if (collecting) await cleanup(environment, run, name);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }

  run.finish(process.exitCode ? 'FAIL' : 'PASS', result);
  if (!process.exitCode) console.log(`${name} scenario PASS: ${JSON.stringify(result)}`);
}

async function cleanup(environment, run, name) {
  try {
    await run.stopCollector();
    run.snapshot();
  } catch (error) {
    process.exitCode = 1;
    console.error(`${name} log collection failed:`, error);
    run.timeline('log collection failed', { message: error.message });
  }
  try {
    run.timeline('remove isolated project', { projectName: environment.projectName });
    environment.removeProject();
    run.timeline('isolated project removed', { projectName: environment.projectName });
  } catch (error) {
    process.exitCode = 1;
    console.error(`${name} cleanup failed:`, error);
  }
}
