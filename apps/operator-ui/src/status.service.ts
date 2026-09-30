import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from './api.service';
import { initialStatus, pollStatus, updateStatus } from './status-state';

@Injectable({ providedIn: 'root' })
export class StatusService {
  readonly view = signal(initialStatus);
  constructor() {
    const api = inject(ApiService);
    pollStatus(() => api.status())
      .pipe(takeUntilDestroyed(inject(DestroyRef)))
      .subscribe((reply) => this.view.update((previous) => updateStatus(previous, reply)));
  }
  available() {
    return this.view().data !== null && !this.view().stale;
  }
}
