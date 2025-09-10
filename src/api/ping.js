export default function handler(req, res) {
  res.status(200).json({ ok: true, now: Date.now(), method: req.method });
}
