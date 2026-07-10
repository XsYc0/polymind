curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"polymind/auto","messages":[{"role":"user","content":"Explain what PolyMind does."}]}'
