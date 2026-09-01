import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const demoScorecards = require('../../src/data/demo-scorecards.json')

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.end(JSON.stringify(body))
}

export default function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET')
    res.end()
    return
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'GET만 허용됩니다.' })
    return
  }
  const tenantId = req.query.tenantId
  sendJson(
    res,
    200,
    demoScorecards.filter((card) => card.tenantId === tenantId),
  )
}
