import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentSettingsDTO, ConversationDTO, ModelOptionDTO, ProjectDTO, ToolInfoDTO } from "@edgemind/shared";
import { api } from "./api";

interface WorkspaceState {
  conversations: ConversationDTO[];
  projects: ProjectDTO[];
  models: ModelOptionDTO[];
  tools: ToolInfoDTO[];
  agentSettings: AgentSettingsDTO | null;
  refreshConversations(): Promise<void>;
  refreshProjects(): Promise<void>;
  refreshMeta(): Promise<void>;
  patchConversation(id: string, patch: Partial<ConversationDTO>): Promise<ConversationDTO>;
}

const Ctx = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<ConversationDTO[]>([]);
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [models, setModels] = useState<ModelOptionDTO[]>([]);
  const [tools, setTools] = useState<ToolInfoDTO[]>([]);
  const [agentSettings, setAgentSettings] = useState<AgentSettingsDTO | null>(null);

  const refreshConversations = useCallback(async () => {
    setConversations(await api<ConversationDTO[]>("/conversations"));
  }, []);
  const refreshProjects = useCallback(async () => {
    setProjects(await api<ProjectDTO[]>("/projects"));
  }, []);
  const refreshMeta = useCallback(async () => {
    const [m, t, s] = await Promise.all([api<ModelOptionDTO[]>("/models"), api<ToolInfoDTO[]>("/tools"), api<AgentSettingsDTO>("/settings/agent")]);
    setModels(m);
    setTools(t);
    setAgentSettings(s);
  }, []);
  const patchConversation = useCallback(async (id: string, patch: Partial<ConversationDTO>) => {
    const r = await api<ConversationDTO>(`/conversations/${id}`, { method: "PATCH", body: patch });
    setConversations((cs) => cs.map((c) => (c.id === id ? r : c)));
    return r;
  }, []);

  useEffect(() => {
    refreshConversations().catch(() => {});
    refreshProjects().catch(() => {});
    refreshMeta().catch(() => {});
  }, [refreshConversations, refreshProjects, refreshMeta]);

  const value = useMemo(
    () => ({ conversations, projects, models, tools, agentSettings, refreshConversations, refreshProjects, refreshMeta, patchConversation }),
    [conversations, projects, models, tools, agentSettings, refreshConversations, refreshProjects, refreshMeta, patchConversation],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace outside WorkspaceProvider");
  return v;
}

export function modelLabel(m: ModelOptionDTO) {
  return m.displayName || m.modelId;
}
