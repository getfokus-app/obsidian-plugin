import { FokusClient } from './client';

export interface ObsidianVaultStatus {
  vaultId: string;
  name?: string;
  folderMappings: Record<string, string>;
}

export interface ObsidianStatus {
  connected: boolean;
  sourceId: string | null;
  vaults: ObsidianVaultStatus[];
  syncTags: boolean;
}

/**
 * The connection record. Its `sourceId` is half the dedupe key every synced
 * note carries — without it a re-sync would create a second copy of every file
 * rather than updating the first.
 */
export class ObsidianSourceApi {
  constructor(private client: FokusClient) {}

  async connect(vault: {
    vaultId: string;
    name?: string;
    platform?: string;
    pluginVersion?: string;
  }): Promise<ObsidianStatus> {
    const { data } = await this.client.request<{ data: ObsidianStatus }>(
      '/integrations/obsidian/connect',
      { method: 'POST', body: { vault } },
    );
    return data;
  }

  async status(): Promise<ObsidianStatus> {
    const { data } = await this.client.request<{ data: ObsidianStatus }>(
      '/integrations/obsidian/status',
    );
    return data;
  }
}

export interface Workspace {
  _id: string;
  name: string;
  isPersonal?: boolean;
}

export class WorkspacesApi {
  constructor(private client: FokusClient) {}

  /** Listed without a workspace header — it is what resolves which one to use. */
  async list(): Promise<Workspace[]> {
    const { data } = await this.client.request<{ data: Workspace[] }>('/v1/workspaces', {
      workspace: false,
    });
    return data ?? [];
  }
}
