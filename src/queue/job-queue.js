import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';

const JOB_TIMEOUT = get('jobTimeoutMs', 300000);

/**
 * Simple single-job queue. Only one job can run at a time.
 */
class JobQueue {
  constructor() {
    this.currentJob = null;
    this.jobs = new Map();
    this.listeners = new Map();
  }

  generateId() {
    return crypto.randomUUID().slice(0, 8);
  }

  /**
   * Create a new job. Returns job ID.
   * Throws JOB_IN_PROGRESS if another job is already active.
   */
  createJob(type, params = {}) {
    if (this.currentJob && this.currentJob.status === 'running') {
      throw new FlowError(
        ErrorCodes.JOB_IN_PROGRESS,
        `A job is already in progress: ${this.currentJob.id} (${this.currentJob.type}). Wait for it to complete.`,
        { currentJobId: this.currentJob.id }
      );
    }

    const id = this.generateId();
    const job = {
      id,
      type,
      params,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      progress: 0,
    };

    this.jobs.set(id, job);
    this.currentJob = job;
    logger.info('Job created', { jobId: id, type });

    return job;
  }

  startJob(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.emit('start', job);
    return job;
  }

  completeJob(id, result) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.result = result;
    job.progress = 100;
    this.currentJob = null;
    this.emit('complete', job);
    logger.info('Job completed', { jobId: id, type: job.type });
    return job;
  }

  failJob(id, error) {
    const job = this.jobs.get(id);
    if (!job) {
      logger.error('Cannot fail unknown job', { jobId: id });
      return null;
    }
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = error instanceof Error ? { message: error.message, code: error.code, stack: error.stack } : { message: String(error) };
    this.currentJob = null;
    this.emit('failed', job);
    logger.error('Job failed', { jobId: id, type: job.type, error: job.error.message });
    return job;
  }

  setManualAction(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'manual_action_required';
    this.emit('manual', job);
  }

  updateProgress(id, progress) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.progress = Math.min(100, Math.max(0, progress));
  }

  getJob(id) {
    return this.jobs.get(id);
  }

  getCurrentJob() {
    return this.currentJob;
  }

  getStatus() {
    return {
      hasActiveJob: this.currentJob?.status === 'running' || this.currentJob?.status === 'queued',
      currentJob: this.currentJob ? {
        id: this.currentJob.id,
        type: this.currentJob.type,
        status: this.currentJob.status,
        progress: this.currentJob.progress,
        createdAt: this.currentJob.createdAt,
      } : null,
      totalJobs: this.jobs.size,
    };
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach(cb => {
      try { cb(data); } catch (err) { logger.error('Job queue listener error', { event, error: err.message }); }
    });
  }
}

export const jobQueue = new JobQueue();
export default jobQueue;
