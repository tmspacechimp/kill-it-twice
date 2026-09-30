import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from './api.service';
import { OperationsService } from './operations.service';
import { StatusService } from './status.service';
import type { Configuration, Reply, Setting } from './contracts';

@Component({
  selector: 'app-controls',
  imports: [FormsModule],
  template: `
    <section aria-labelledby="controls-heading">
      <h2 id="controls-heading">Replication controls</h2>
      @if (!status.available()) {
        <p>Unavailable: a successful replicator status response is required.</p>
      }
      <div class="actions">
        <button [disabled]="gateDisabled()" (click)="replication('start')">
          Start replication
        </button>
        <button [disabled]="gateDisabled()" (click)="replication('stop')">Graceful stop</button>
      </div>
      <p role="status">{{ message() }}</p>
      <h3>Supported configuration</h3>
      <button [disabled]="pending()" (click)="loadConfiguration()">Refresh configuration</button>
      @if (configurationReason()) {
        <p>{{ configurationReason() }}</p>
      }
      @if (settings().length) {
        <form (ngSubmit)="saveConfiguration()">
          @for (setting of settings(); track setting.key) {
            <label
              >{{ setting.key }}
              @if (inputType(setting) === 'checkbox') {
                <input
                  type="checkbox"
                  [name]="setting.key"
                  [(ngModel)]="setting.value"
                  [disabled]="gateDisabled()"
                />
              } @else if (inputType(setting) === 'number') {
                <input
                  type="number"
                  [name]="setting.key"
                  [(ngModel)]="setting.value"
                  [disabled]="gateDisabled()"
                />
              } @else {
                <input
                  type="text"
                  [name]="setting.key"
                  [(ngModel)]="setting.value"
                  [disabled]="gateDisabled()"
                />
              }
            </label>
            <p class="hint">{{ setting.description }} Applies: {{ setting.appliesAt }}</p>
          }
          <button [disabled]="gateDisabled()">Save configuration</button>
        </form>
      }
      <h3>Generate source events</h3>
      <p>Finish seeding first. Run only one source writer, including commands outside this page.</p>
      <form #generation="ngForm" (ngSubmit)="generate()">
        <label
          >Event count
          <input
            name="count"
            type="number"
            min="1"
            max="2147483647"
            step="1"
            required
            [(ngModel)]="count"
        /></label>
        <label
          >Events per second
          <input name="rate" type="number" min="1" max="1000" step="1" required [(ngModel)]="rate"
        /></label>
        <button [disabled]="generation.invalid || operations.busy(['writer'])">
          Generate events
        </button>
      </form>
    </section>
  `,
})
export class ControlsComponent {
  private readonly api = inject(ApiService);
  readonly operations = inject(OperationsService);
  readonly status = inject(StatusService);
  readonly settings = signal<Setting[]>([]);
  readonly configurationReason = signal('Loading supported settings.');
  readonly message = signal('');
  readonly pending = signal(false);
  count = 500;
  rate = 20;

  constructor() {
    void this.loadConfiguration();
  }
  gateDisabled() {
    return !this.status.available() || this.pending() || this.operations.busy(['replicator']);
  }
  inputType(setting: Setting) {
    return typeof setting.value === 'boolean'
      ? 'checkbox'
      : typeof setting.value === 'number'
        ? 'number'
        : 'text';
  }

  async loadConfiguration(): Promise<void> {
    this.pending.set(true);
    try {
      this.applyConfiguration(await this.api.request<Reply<Configuration>>('GET', '/config'));
    } catch (error) {
      this.settings.set([]);
      this.configurationReason.set('Unavailable: ' + errorMessage(error));
    } finally {
      this.pending.set(false);
    }
  }

  async saveConfiguration(): Promise<void> {
    this.pending.set(true);
    try {
      const values = Object.fromEntries(
        this.settings().map((setting) => [setting.key, setting.value]),
      );
      const reply = await this.operations.gate(['replicator'], () =>
        this.api.request<Reply<Configuration>>('PUT', '/config', { values }),
      );
      this.applyConfiguration(reply);
      this.message.set(
        reply.available ? 'Configuration confirmed. See when each change applies.' : reply.reason,
      );
    } catch (error) {
      this.message.set(errorMessage(error));
    } finally {
      this.pending.set(false);
    }
  }

  async replication(action: 'start' | 'stop'): Promise<void> {
    this.pending.set(true);
    this.message.set('Waiting for confirmation.');
    try {
      const reply = await this.operations.gate(['replicator'], () =>
        this.api.request<Reply<{ completed: true; message: string }>>(
          'POST',
          '/replication/' + action,
        ),
      );
      this.message.set(reply.available ? reply.data.message : reply.reason);
    } catch (error) {
      this.message.set(errorMessage(error));
    } finally {
      this.pending.set(false);
    }
  }

  generate() {
    void this.operations.run('/source/generate', ['writer'], {
      count: this.count,
      rate: this.rate,
    });
  }

  private applyConfiguration(reply: Reply<Configuration>): void {
    this.settings.set(reply.available ? reply.data.settings : []);
    this.configurationReason.set(
      reply.available
        ? reply.data.settings.length
          ? ''
          : 'No editable settings advertised.'
        : reply.reason,
    );
  }
}
