import type { AssetMeta, ResourceGroup, ResourceTransferProgress } from '../types';

export interface OutboundResourceTransfer {
  key: string;
  group: ResourceGroup;
  asset: AssetMeta;
  signature: string;
  transferVersion?: string;
  dataBase64: string;
}

export interface CompletedResourceTransfer {
  key: string;
  group: ResourceGroup;
  asset: AssetMeta;
  signature: string;
  transferVersion?: string;
  dataBase64: string;
}

export interface ResourceTransferInvalidation {
  key: string;
  group: ResourceGroup;
  assetId: string;
}

const outboundEvent = 'timenotes-resource-transfer-outbound';
const completedEvent = 'timenotes-resource-transfer-completed';
const progressEvent = 'timenotes-resource-transfer-progress';
const transportReadyEvent = 'timenotes-resource-transfer-ready';
const invalidatedEvent = 'timenotes-resource-transfer-invalidated';

export function announceOutboundResourceTransfer(payload: OutboundResourceTransfer) {
  dispatch(outboundEvent, payload);
}

export function subscribeOutboundResourceTransfer(handler: (payload: OutboundResourceTransfer) => void) {
  return subscribe(outboundEvent, handler);
}

export function announceCompletedResourceTransfer(payload: CompletedResourceTransfer) {
  dispatch(completedEvent, payload);
}

export function subscribeCompletedResourceTransfer(handler: (payload: CompletedResourceTransfer) => void) {
  return subscribe(completedEvent, handler);
}

export function announceResourceTransferInvalidated(payload: ResourceTransferInvalidation) {
  dispatch(invalidatedEvent, payload);
}

export function subscribeResourceTransferInvalidated(handler: (payload: ResourceTransferInvalidation) => void) {
  return subscribe(invalidatedEvent, handler);
}

export function announceResourceTransferProgress(progress: ResourceTransferProgress) {
  dispatch(progressEvent, progress);
}

export function subscribeResourceTransferProgress(handler: (payload: ResourceTransferProgress) => void) {
  return subscribe(progressEvent, handler);
}

export function announceResourceTransportReady() {
  dispatch(transportReadyEvent, {});
}

export function subscribeResourceTransportReady(handler: () => void) {
  return subscribe(transportReadyEvent, handler);
}

function dispatch<T>(name: string, detail: T) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function subscribe<T>(name: string, handler: (payload: T) => void) {
  const listener = (event: Event) => handler((event as CustomEvent<T>).detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}
