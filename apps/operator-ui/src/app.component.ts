import { Component, inject } from '@angular/core';
import { StatusComponent } from './status.component';
import { ControlsComponent } from './controls.component';
import { DlqComponent } from './dlq.component';
import { SimulationsComponent } from './simulations.component';
import { OperationsService } from './operations.service';

@Component({
  selector: 'app-root',
  imports: [StatusComponent, ControlsComponent, DlqComponent, SimulationsComponent],
  template: `
    <main>
      <header>
        <h1>Shipment operator</h1>
        <p>Inspect replication and run local pipeline controls.</p>
        <a [href]="dashboardsUrl" target="_blank" rel="noopener"
          >Browse shipments in OpenSearch Dashboards</a
        >
      </header>
      <app-status />
      <app-controls />
      <app-dlq />
      <app-simulations />
      <section aria-labelledby="operations-heading">
        <h2 id="operations-heading">Operations</h2>
        <p role="status">{{ operations.message() }}</p>
        @if (operations.trackingError()) {
          <p class="warning" role="alert">{{ operations.trackingError() }}</p>
        }
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>State</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            @for (operation of operations.records(); track operation.id) {
              <tr>
                <td>{{ operation.action }}</td>
                <td>{{ operation.state }}</td>
                <td>
                  <pre>{{ operation.message }}</pre>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="3">No commands submitted in this page session.</td>
              </tr>
            }
          </tbody>
        </table>
      </section>
    </main>
  `,
})
export class AppComponent {
  readonly operations = inject(OperationsService);
  readonly dashboardsUrl = (() => {
    const url = new URL('/app/discover', window.location.href);
    const port = (window as Window & { operatorDashboardsPort?: string }).operatorDashboardsPort;
    url.port = port && /^[0-9]+$/.test(port) ? port : '5601';
    url.hash = '/?_a=(columns:!(shipment_id,version,status,id,occurred_at),index:shipments)';
    return url.href;
  })();
}
