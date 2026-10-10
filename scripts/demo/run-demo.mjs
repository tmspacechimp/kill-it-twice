import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { RunEvidence } from '../logging/run-evidence.mjs';
import { runDocker } from '../logging/docker.mjs';
import { DemoReport } from './demo-report.mjs';
import { DemoWorkflow, readDemoOptions } from './demo-workflow.mjs';

if (existsSync('.env')) loadEnvFile('.env');
const options = readDemoOptions();
const evidence = new RunEvidence('demo', options);
const settings = { DEMO_SEED_SHIPMENTS: String(options.seedShipments) };
const compose = (...arguments_) => runDocker(['compose', ...arguments_], settings);
let interrupted = false;
let stop;
const stopped = new Promise((resolve) => { stop = resolve; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = true;
    evidence.timeline('operator stopped log collection', { signal });
    stop();
  });
}
const workflow = new DemoWorkflow(compose, evidence, options, () => interrupted);
let validationCancelled = false;
const report = new DemoReport(compose, evidence, workflow, () => interrupted || validationCancelled);
report.save();
let projectName;
let validation;

try {
  // The resolved configuration contains passwords; only retain its project name.
  projectName = JSON.parse(compose('config', '--format', 'json')).name;
  evidence.startCollector(projectName, options.maxLogBytes);
  await workflow.start();
  validation = report.run();
  console.log('Traffic generated. Replication may still be running; use make logs to watch progress.\nCollecting service logs; Ctrl+C finishes this run and leaves services available.');
  await Promise.race([
    validation.then(() => stopped),
    evidence.collectorResult.then((result) => {
      if (!interrupted) throw new Error(`Log collector stopped unexpectedly: ${JSON.stringify(result)}`);
    }),
  ]);
} catch (error) {
  validationCancelled = true;
  if (validation) await validation.catch(() => {});
  if (!interrupted) process.exitCode = 1;
  evidence.timeline('demo run stopped', { message: error.message, interrupted });
  console.error(error.message);
  report.result.status = interrupted ? 'INTERRUPTED' : 'FAIL';
  report.result.error = error.message;
  report.save();
} finally {
  try {
    await evidence.stopCollector();
    if (projectName) evidence.snapshot();
    // Remove only this command's retained one-off jobs after saving their logs.
    const names = runDocker(['ps', '-a', '--format', '{{.Names}}']).trim().split('\n');
    const completedJobs = workflow.jobs.filter((name) => names.includes(name));
    if (completedJobs.length) runDocker(['rm', ...completedJobs]);
    report.result.checks.logCollection = 'PASS';
  } catch (error) {
    process.exitCode = 1;
    console.error(error.message);
    evidence.timeline('log collection or job cleanup failed', { message: error.message });
    report.result.status = 'FAIL';
    report.result.checks.logCollection = 'FAIL';
    report.result.error = error.message;
  }
  report.save();
  evidence.finish(process.exitCode ? 'FAIL' : report.result.status === 'PASS' ? 'PASS' : interrupted ? 'STOPPED' : 'INCOMPLETE', report.result);
}
