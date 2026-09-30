import { Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { StatusService } from './status.service';
import type { StatusData } from './contracts';

@Component({
  selector: 'app-status',
  imports: [DatePipe],
  template: `
    <section aria-labelledby="status-heading">
      <h2 id="status-heading">Replication status</h2>
      @if (status.view().reason) {
        <p class="notice" role="status">{{ status.view().reason }}</p>
      }
      @if (status.view().stale) {
        <p class="warning"><strong>Stale values</strong> — showing the last successful response.</p>
      }
      <p>
        Latest successful status: {{ (status.view().receivedAt | date: 'medium') || 'None yet' }}
      </p>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Value</th>
            <th>Definition / availability</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>Replication state</th>
            <td colspan="2">{{ replicationState() }}</td>
          </tr>
          @for (row of rows; track row.key) {
            <tr>
              <th>{{ row.label }}</th>
              @if (status.view().data?.metrics?.[row.key]; as metric) {
                @if (metric.available) {
                  <td>{{ metric.value }} {{ metric.unit }}</td>
                  <td>{{ metric.definition }}</td>
                } @else {
                  <td>Unavailable</td>
                  <td>{{ metric.reason }}</td>
                }
              } @else {
                <td>Unavailable</td>
                <td>No successful status response.</td>
              }
            </tr>
          }
        </tbody>
      </table>
      <h3>Component health</h3>
      <table>
        <thead>
          <tr>
            <th>Component</th>
            <th>State</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          @for (component of status.view().data?.health || []; track component.component) {
            <tr>
              <td>{{ component.component }}</td>
              <td>{{ component.state }}</td>
              <td>{{ component.reason }}</td>
            </tr>
          } @empty {
            <tr>
              <td colspan="3">Component health is unavailable.</td>
            </tr>
          }
        </tbody>
      </table>
    </section>
  `,
})
export class StatusComponent {
  readonly status = inject(StatusService);
  readonly rows: { key: keyof StatusData['metrics']; label: string }[] = [
    { key: 'initialLoadProgress', label: 'Initial-load progress' },
    { key: 'throughput', label: 'Throughput' },
    { key: 'incrementalLag', label: 'Incremental lag' },
    { key: 'dlqCount', label: 'DLQ count' },
  ];
  replicationState(): string {
    const state = this.status.view().data?.replicationState;
    if (!state) return 'Unavailable';
    return state.available ? state.value : 'Unavailable: ' + state.reason;
  }
}
