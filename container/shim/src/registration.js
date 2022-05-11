import { exec as CpExec } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { cpus, freemem, totalmem } from 'node:os'
import fsPromises from 'node:fs/promises'
import { promisify } from 'node:util'
import fetch from 'node-fetch'
import Debug from 'debug'

import { DEV_VERSION, NODE_OPERATOR_EMAIL, NODE_VERSION, nodeId, ORCHESTRATOR_URL, updateNodeToken } from './config.js'

const exec = promisify(CpExec)

const debug = Debug('node:registration')

const CERT_PATH = '/usr/src/app/shared/ssl/node.crt'
const KEY_PATH = '/usr/src/app/shared/ssl/node.key'
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000

export async function register (initial) {
  const body = { nodeId, version: NODE_VERSION, operatorEmail: NODE_OPERATOR_EMAIL }

  if (initial) {
    body.memoryStats = await getMemoryStats()
    body.diskStats = await getDiskStats()
    body.cpuStatus = await getCPUStats()
    if (NODE_VERSION !== DEV_VERSION) {
      body.speedtest = await getSpeedtest()
    }
  }

  const registerOptions = postOptions(body)

  const certExists = await fsPromises.stat(CERT_PATH).catch(_ => false)

  // If cert is not yet in the volume, register
  if (!certExists) {
    debug('Registering with orchestrator, requesting new TLS cert... (this could take up to 20 mins)')
    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/register`, registerOptions)
      const body = await response.json()
      const { cert, key } = body

      if (!cert || !key) {
        debug('Received status %d with %o', response.status, body)
        throw new Error(body?.error || 'Empty cert or key received')
      }

      debug('TLS cert and key received, persisting to shared volume...')

      await Promise.all([
        fsPromises.writeFile(CERT_PATH, cert), fsPromises.writeFile(KEY_PATH, key)
      ])

      debug('Successful registration, restarting container...')

      process.exit()
    } catch (e) {
      debug('Failed registration %o', e)
      process.exit(1)
    }
  } else {
    if (initial) {
      const certBuffer = await fsPromises.readFile(CERT_PATH)

      const cert = new X509Certificate(certBuffer)

      const validTo = Date.parse(cert.validTo)

      if (Date.now() > (validTo - FIVE_DAYS_MS)) {
        debug('Certificate is soon to expire, deleting and rebooting...')
        await Promise.all([
          fsPromises.unlink(CERT_PATH).catch(debug), fsPromises.unlink(CERT_PATH).catch(debug)
        ])
        process.exit()
      } else {
        debug(`Certificate is valid until ${cert.validTo}`)
      }
    }

    debug('Re-registering with orchestrator...')

    try {
      const { token } = await fetch(`${ORCHESTRATOR_URL}/register?ssl=done`, registerOptions).then(res => res.json())

      updateNodeToken(token)

      debug('Successful re-registration, updated token')
    } catch (e) {
      debug('Failed re-registration %s', e.message)
    }
  }
  setTimeout(register, (Math.random() * 2 + 4) * 60 * 1000)
}

export async function deregister () {
  debug('De-registering from orchestrator')
  try {
    await fetch(`${ORCHESTRATOR_URL}/deregister`, postOptions({ nodeId }))
    debug('De-registered successfully')
  } catch (err) {
    debug(err)
  }
}

async function getMemoryStats () {
  const nodeAvailableMemory = (freemem() / 1021 / 1024 / 1024).toFixed(1)
  const nodeTotalMemory = (totalmem() / 1021 / 1024 / 1024).toFixed(1)
  const result = await fsPromises.readFile('/proc/meminfo', 'utf-8')
  const values = result.trim().split('\n').slice(0, 3).map(res => res.split(':').map(kv => kv.trim())).reduce((acc, cv) => {
    return Object.assign(acc, { [cv[0]]: Number((cv[1].split(' ')[0] / 1024 / 1024).toFixed(1)) })
  }, {})
  debug(`Total memory: ${values.MemTotal} GB / ${nodeTotalMemory} GB Free: ${values.MemFree} GB Available: ${values.MemAvailable} GB / ${nodeAvailableMemory} GB`)
  return { procTotalMemory: values.MemTotal, nodeTotalMemory, procFreeMemory: values.MemFree, procAvailableMemory: values.MemAvailable, nodeAvailableMemory }
}

async function getDiskStats () {
  const { stdout: result } = await exec('df -BG /usr/src/app/shared')
  const values = result.trim().split('\n')[1].split(/\s+/).map(res => res.replace('G', ''))
  const totalDisk = Number(values[1])
  const usedDisk = Number(values[2])
  const availableDisk = Number(values[3])
  debug(`Total disk: ${totalDisk} Used: ${usedDisk} Available: ${availableDisk}`)
  return { totalDisk, usedDisk, availableDisk }
}

async function getCPUStats () {
  const result = await fsPromises.readFile('/proc/cpuinfo', 'utf-8')
  const procCPUs = result.trim().split('\n\n').length
  const nodeCPUs = cpus().length
  debug(`CPUs: ${procCPUs} / ${nodeCPUs}`)
  return { procCPUs, nodeCPUs }
}

async function getSpeedtest () {
  debug('Executing speedtest')
  const { stdout: result } = await exec('speedtest --accept-license -f json')
  const values = JSON.parse(result)
  debug(values)
  return values
}

function postOptions (body) {
  return {
    method: 'post', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }
  }
}
