import { Observable, catchError, exhaustMap, of, timer } from 'rxjs';
import type { StatusReply, StatusData } from './contracts.js';

export type StatusView = {
  data: StatusData | null;
  receivedAt: string | null;
  stale: boolean;
  reason: string;
};
export const initialStatus: StatusView = {
  data: null,
  receivedAt: null,
  stale: false,
  reason: 'Waiting for status.',
};

export function updateStatus(previous: StatusView, reply: StatusReply): StatusView {
  if (reply.available)
    return { data: reply.data, receivedAt: reply.receivedAt, stale: false, reason: '' };
  return { ...previous, stale: previous.data !== null, reason: reply.reason };
}

export function pollStatus(
  request: () => Observable<StatusReply>,
  ticks: Observable<unknown> = timer(0, 2000),
) {
  return ticks.pipe(
    exhaustMap(() =>
      request().pipe(
        catchError(() =>
          of({
            available: false as const,
            code: 'unreachable',
            reason: 'Operator status request failed or timed out.',
            receivedAt: null,
          }),
        ),
      ),
    ),
  );
}
