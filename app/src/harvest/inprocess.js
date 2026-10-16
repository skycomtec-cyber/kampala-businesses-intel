import path from 'node:path'

import { runScheduledHarvests } from './schedule.js'

/**
 * The in-process harvest scheduler.
 *
 * Harvest due-ness is derived per plan from the catalogue's last completed run
 * and the `cadenceDays` declared on each plan, so there is no single timestamp
 * to persist. A plan that has never run is due, a plan whose last run is older
 * than its cadence is due, and a failed run does not reset that clock — the
 * harvest scheduler's own semantics still apply.
 *
 * The switch is `config.harvest.schedule` (KIP_HARVEST_SCHEDULE). It is off by
 * default because harvesting makes outbound requests to third-party sites; on a
 * host a timer runs `npm run harvest:schedule`, and on a platform-as-a-service
 * without a timer the server runs it itself.
 *
 * The check interval bounds how often the server scans plans for due work. It
 * does not change the per-plan cadence; it only affects latency and retry
 * cadence for a plan that stays due (e.g., because its source is unreachable).
 * Failures do not advance a plan's cadence, so they will be retried at the
 * check interval until a run completes or a plan is paused by removing its
 * cadence.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const INITIAL_DELAY_MS = 60 * 1000

export function createHarvestScheduler(app, config, deps = {}) {
  const logger = deps.logger ?? console
  const now = deps.now ?? (() => new Date())
  const checkIntervalMs = deps.checkIntervalMs ?? CHECK_INTERVAL_MS
  const initialDelayMs = deps.initialDelayMs ?? INITIAL_DELAY_MS
  const plansDir = deps.plansDir ?? config.harvest?.plansDir
  const archiveRoot = deps.archiveRoot ?? config.harvest?.archiveDir
  const batchDir = deps.batchDir ?? path.join(config.dataDir, 'harvest-batches')

  let running = false
  let checkTimer = null
  let initialTimer = null

  const enabled = Boolean(config.harvest?.schedule)

  async function runOnce(options = {}) {
    if (running) return { skipped: true, reason: 'already-running' }
    running = true
    try {
      const report = await runScheduledHarvests(app, {
        plansDir,
        dryRun: false,
        all: false,
        fromDir: null,
        archiveRoot,
        batchDir,
        now: now(),
        actor: options.actor ?? null,
      })
      return report
    } finally {
      running = false
    }
  }

  async function checkNow() {
    if (!enabled) return { skipped: true, reason: 'disabled' }
    return runOnce()
  }

  function start() {
    if (!enabled) {
      logger.info?.('self-scheduled harvesting is off (set KIP_HARVEST_SCHEDULE=true to enable)')
      return
    }
    if (checkTimer || initialTimer) return

    logger.info?.(
      { plansDir, archiveRoot, batchDir, checkIntervalMs, initialDelayMs },
      'self-scheduled harvesting is on',
    )

    const fire = () => {
      checkNow().catch((error) => {
        logger.error?.({ err: error }, 'scheduled harvest check failed')
      })
    }

    initialTimer = setTimeout(fire, initialDelayMs)
    initialTimer.unref?.()
    checkTimer = setInterval(fire, checkIntervalMs)
    checkTimer.unref?.()
  }

  function stop() {
    if (initialTimer) {
      clearTimeout(initialTimer)
      initialTimer = null
    }
    if (checkTimer) {
      clearInterval(checkTimer)
      checkTimer = null
    }
  }

  return {
    start,
    stop,
    checkNow,
    runOnce,
    isRunning: () => running,
  }
}
