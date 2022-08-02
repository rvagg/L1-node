import fsPromises from 'node:fs/promises'
import { cpus } from 'node:os'
import express from 'express'
import mimeTypes from 'mime-types'
import followRedirects from 'follow-redirects'

import { addRegisterCheckRoute, deregister, register } from './modules/registration.js'
import {
  FIL_WALLET_ADDRESS,
  NODE_OPERATOR_EMAIL,
  NODE_UA,
  NODE_VERSION,
  nodeId,
  PORT,
  TESTING_CID
} from './config.js'
import { streamCAR } from './utils/car.js'
import { trapServer } from './utils/trap.js'
import { debug } from './utils/logging.js'

import cluster from 'node:cluster'
import { submitRetrievals, initLogIngestor } from './modules/log_ingestor.js'

const { https } = followRedirects

const GATEWAY_TIMEOUT = 120_000

if (cluster.isPrimary) {
  debug('Saturn L1 Node')
  debug.extend('id')(nodeId)
  debug.extend('version')(NODE_VERSION)
  debug.extend('important')('===== IMPORTANT =====')
  debug.extend('important')(`Earnings will be sent to Filecoin wallet address: ${FIL_WALLET_ADDRESS}`)
  debug.extend('important')(NODE_OPERATOR_EMAIL ? `Payment notifications and important update will be sent to: ${NODE_OPERATOR_EMAIL}` : 'NO OPERATOR EMAIL SET, WE HIGHLY RECOMMEND SETTING ONE')
  debug.extend('important')('===== IMPORTANT =====')

  for (let i = 0; i < cpus().length; i++) {
    cluster.fork()
  }

  cluster.on('exit', () => {
    if (Object.keys(cluster.workers).length === 0) {
      debug('All servers closed')
      shutdownCluster()
    }
  })

  process.on('SIGQUIT', shutdownCluster)
  process.on('SIGINT', shutdownCluster)

  setTimeout(async function () {
    await register(true).catch(err => {
      debug(`Failed to register ${err.name} ${err.message}`)
      process.exit(1)
    })

    // Start log ingestor
    await initLogIngestor()
  }, 500)
} else {
  const ipfsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: Math.floor(256 / cpus().length)
  })

  const app = express()

  const testCAR = await fsPromises.readFile('./public/QmQ2r6iMNpky5f1m4cnm3Yqw8VSvjuKpTcK1X7dBR1LkJF.car')

  app.disable('x-powered-by')
  app.set('trust proxy', true)

  app.get('/favicon.ico', (req, res) => {
    res.sendStatus(404)
  })

  // Whenever nginx doesn't have a CAR file in cache, this is called
  app.get('/ipfs/:cid', handleCID)
  app.get('/ipfs/:cid/:path*', handleCID)

  async function handleCID (req, res) {
    const cid = req.params.cid
    const path = req.params.path ? (req.params.path + req.params[0]) : null
    const format = getResponseFormat(req)

    debug(`Cache miss for ${cid}` + (path ? `/${path}` : ''))

    res.set({
      'Content-Type': mimeTypes.lookup(path) || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Saturn-Node-Id': nodeId,
      'Saturn-Node-Version': NODE_VERSION
    })

    if (req.headers.range) {
      let [start, end] = req.headers.range.split('=')[1].split('-')
      start = parseInt(start, 10)
      end = parseInt(end, 10)

      res.set({
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${testCAR.length}`
      })
      return res.status(206).end(testCAR.slice(start, end + 1))
    }

    // Testing CID
    if (cid === TESTING_CID) {
      return res.send(testCAR)
    }

    let ipfsUrl = `https://ipfs.io/ipfs/${cid}`
    if (path) {
      ipfsUrl += `/${path}`
    }
    if (format) {
      ipfsUrl += `?format=${format}`
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, GATEWAY_TIMEOUT)

    const ipfsReq = https.get(ipfsUrl, {
      agent: ipfsAgent,
      timeout: GATEWAY_TIMEOUT,
      headers: { 'User-Agent': NODE_UA },
      signal: controller.signal
    }, async fetchRes => {
      clearTimeout(timeout)
      const { statusCode } = fetchRes
      if (statusCode !== 200) {
        debug.extend('error')(`Invalid response from IPFS gateway (${statusCode}) for ${cid}`)
        fetchRes.resume()
        return res.sendStatus(502)
      }

      res.set('Content-Type', fetchRes.headers['content-type'])

      if (format === 'car') {
        streamCAR(fetchRes, res).catch(() => {})
      } else {
        fetchRes.pipe(res)
      }
    }).on('error', err => {
      clearTimeout(timeout)
      debug.extend('error')(`Error fetching from IPFS gateway for ${cid}: ${err.name} ${err.message}`)
      if (controller.signal.aborted) {
        return res.sendStatus(504)
      }
      res.sendStatus(502)
    }).on('timeout', () => {
      clearTimeout(timeout)
      debug.extend('error')(`Timeout from IPFS gateway for ${cid}`)
      ipfsReq.destroy()
      res.destroy()
    })

    req.on('close', () => {
      clearTimeout(timeout)
      if (!res.writableEnded) {
        debug.extend('error')('Client aborted early, terminating gateway request')
        ipfsReq.destroy()
      }
    })
  }

  addRegisterCheckRoute(app)

  const server = app.listen(PORT, '127.0.0.1', async () => {
    debug.extend('server')('shim process running')
  })

  trapServer(server)
}

function getResponseFormat (req) {
  // ipfs gw returns default format for invalid formats
  if (req.query.format) {
    return req.query.format
  } else if (req.headers.accept === 'application/vnd.ipld.car') {
    return 'car'
  } else if (req.headers.accept === 'application/vnd.ipld.raw') {
    return 'raw'
  } else {
    return null
  }
}

async function shutdownCluster () {
  try {
    await Promise.allSettled([
      submitRetrievals(),
      deregister()
    ])
  } catch (err) {
    debug(`Failed during shutdown: ${err.name} ${err.message}`)
  } finally {
    if (Object.keys(cluster.workers).length === 0) {
      debug('Exiting...')
      process.exit(0)
    }
  }
}
