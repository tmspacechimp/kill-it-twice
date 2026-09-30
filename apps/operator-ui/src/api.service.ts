import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import type { StatusReply } from './contracts';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  status() {
    return this.http.get<StatusReply>('/api/status').pipe(timeout(2000));
  }

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return firstValueFrom(
      this.http.request<T>(method, '/api' + path, { body }).pipe(timeout(6000)),
    );
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse && typeof error.error?.reason === 'string')
    return error.error.reason;
  return 'The operator request failed or timed out. Completion is unknown; inspect state before retrying.';
}
