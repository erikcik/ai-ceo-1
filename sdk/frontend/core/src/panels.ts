export type PanelName = 'events' | 'trajectory' | 'briefings' | 'research' | 'revisions';

export const PANEL_NAMES: readonly PanelName[] = ['events', 'trajectory', 'briefings', 'research', 'revisions'];

export const PANEL_LABELS: Record<PanelName, string> = {
  events: 'Events',
  trajectory: 'Trajectory',
  briefings: 'Briefings',
  research: 'Research',
  revisions: 'Plan revisions',
};

export interface PanelState {
  open: boolean;
  panel: PanelName;
}

export const DEFAULT_PANEL_STATE: PanelState = { open: false, panel: 'events' };

export type PanelAction =
  | { type: 'open'; panel: PanelName }
  | { type: 'close' }
  | { type: 'toggle'; panel: PanelName };

export function reducePanelState(state: PanelState, action: PanelAction): PanelState {
  if (action.type === 'close') return state.open ? { ...state, open: false } : state;
  if (action.type === 'open') return state.open && state.panel === action.panel ? state : { open: true, panel: action.panel };
  return state.open && state.panel === action.panel ? { ...state, open: false } : { open: true, panel: action.panel };
}
