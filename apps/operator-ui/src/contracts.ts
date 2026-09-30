export type Unavailable = { available: false; code: string; reason: string };
export type Available<T> = { available: true; data: T };
export type Reply<T> = Available<T> | Unavailable;
export type Measurement =
  { available: true; value: number; unit: string; definition: string } | Unavailable;
export type StatusData = {
  replicationState: { available: true; value: string } | Unavailable;
  metrics: Record<
    'initialLoadProgress' | 'throughput' | 'incrementalLag' | 'dlqCount',
    Measurement
  >;
  health: { component: string; state: string; reason: string }[];
};
export type StatusReply =
  (Available<StatusData> & { receivedAt: string }) | (Unavailable & { receivedAt: null });
export type Setting = {
  key: string;
  value: string | number | boolean;
  description: string;
  appliesAt: string;
};
export type Configuration = { settings: Setting[] };
export type DlqEntry = { id: string; record: Record<string, unknown>; reason: string };
export type DlqPage = { entries: DlqEntry[]; nextCursor: string | null };
export type Resource = 'writer' | 'replicator' | 'opensearch';
export type Operation = {
  id: string;
  action: string;
  resources: Resource[];
  state: 'pending' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  message: string;
};
