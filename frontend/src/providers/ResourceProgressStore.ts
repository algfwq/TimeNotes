import { useSyncExternalStore } from 'react';
import type { ResourceGroup, ResourceTransferProgress } from '../types';

type ProgressMap = Record<string, ResourceTransferProgress>;

const listeners = new Set<() => void>();
let state: ProgressMap = {};
let pendingState: ProgressMap | undefined;
let pendingTimer: number | undefined;
const progressNotifyIntervalMs = 180;

export function resourceProgressKey(group: ResourceGroup, id: string) {
  return `${group}:${id}`;
}

export function setResourceProgressMap(next: ProgressMap, completedKeys: string[] = []) {
  const nextProgress = { ...next };
  completedKeys.forEach((key) => {
    delete nextProgress[key];
  });
  scheduleProgress(nextProgress);
}

export function mergeResourceProgress(next: ProgressMap, completedKeys: string[] = []) {
  const merged = { ...currentProgress(), ...next };
  completedKeys.forEach((key) => {
    delete merged[key];
  });
  scheduleProgress(merged);
}

export function upsertResourceProgress(progress: ResourceTransferProgress) {
  scheduleProgress({ ...currentProgress(), [progress.key]: progress });
}

export function removeResourceProgress(key: string) {
  const current = currentProgress();
  if (!current[key]) {
    return;
  }
  const next = { ...current };
  delete next[key];
  scheduleProgress(next);
}

export function useResourceProgressMap() {
  return useSyncExternalStore(subscribeProgress, getProgressSnapshot, getProgressSnapshot);
}

export function useResourceProgress(group: ResourceGroup, id?: string) {
  const progress = useResourceProgressMap();
  return id ? progress[resourceProgressKey(group, id)] : undefined;
}

function subscribeProgress(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getProgressSnapshot() {
  return state;
}

function currentProgress() {
  return pendingState ?? state;
}

function scheduleProgress(next: ProgressMap) {
  pendingState = next;
  if (pendingTimer) {
    return;
  }
  pendingTimer = window.setTimeout(() => {
    pendingTimer = undefined;
    if (!pendingState || pendingState === state) {
      pendingState = undefined;
      return;
    }
    state = pendingState;
    pendingState = undefined;
    listeners.forEach((listener) => listener());
  }, progressNotifyIntervalMs);
}
