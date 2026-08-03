# Manual Windows acceptance checklist

On a Windows test PC with Rongta driver and Node 18+:

- [ ] 1. Existing manual `npm start` works
- [ ] 2. Stop manual agent (Ctrl+C)
- [ ] 3. Install service as Administrator (`npm run service:install`)
- [ ] 4. `npm run service:status` shows RUNNING / Automatic
- [ ] 5. ERP agent becomes ONLINE
- [ ] 6. ERP Test Connection succeeds
- [ ] 7. ERP Test Print prints one 100 × 50 mm label
- [ ] 8. Close all PowerShell windows — agent remains ONLINE
- [ ] 9. Restart PC
- [ ] 10. Agent returns ONLINE automatically
- [ ] 11. Printer-offline state is reported without service crash-loop
- [ ] 12. Reconnect printer and confirm recovery
- [ ] 13. Stop service → ERP OFFLINE; start service → ONLINE
- [ ] 14. Uninstall service → config.json and logs remain under ProgramData
- [ ] 15. `npm start` still works after uninstall (manual mode)

Do not commit production secrets. Do not paste agent secrets into tickets or logs.
