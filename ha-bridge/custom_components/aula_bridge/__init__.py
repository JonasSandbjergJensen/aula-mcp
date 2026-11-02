"""Expose cached Aula data through HA's own authenticated HTTP API."""
from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.http.const import KEY_HASS
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.core import SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from .api import BridgeApi, BridgeError
from .const import DOMAIN, PLATFORMS
from .coordinator import AulaCoordinator


class AulaView(HomeAssistantView):
    url = "/api/aula_bridge/snapshot"
    extra_urls = ["/api/aula_bridge/tools", "/api/aula_bridge/call",
                  "/api/aula_bridge/refresh", "/api/aula_bridge/files/{attachment_id}"]
    name = "api:aula_bridge"
    requires_auth = True
    max_body_size = 65536

    def coordinator(self, request):
        entries = request.app[KEY_HASS].data.get(DOMAIN, {})
        return next(iter(entries.values()), None)

    async def get(self, request, attachment_id=None):
        coordinator = self.coordinator(request)
        if coordinator is None:
            return self.json({"error": "not_configured"}, status_code=503)
        try:
            if attachment_id is not None:
                import uuid
                file_id = str(uuid.UUID(attachment_id))
                content, disposition = await coordinator.api.request("files/" + file_id, binary=True)
                return web.Response(body=content, headers={"Content-Type": "application/octet-stream",
                    "Content-Disposition": disposition, "Cache-Control": "no-store"})
            if request.path.endswith("/tools"):
                return self.json(await coordinator.api.request("tools"), headers={"Cache-Control": "no-store"})
            return self.json({"available": coordinator.last_update_success,
                              "snapshot": coordinator.data}, headers={"Cache-Control": "no-store"})
        except (BridgeError, ValueError):
            return self.json({"error": "upstream_unavailable"}, status_code=502)

    async def post(self, request):
        coordinator = self.coordinator(request)
        if coordinator is None:
            return self.json({"error": "not_configured"}, status_code=503)
        try:
            if request.path.endswith("/refresh"):
                await coordinator.async_request_refresh()
                return self.json({"ok": coordinator.last_update_success})
            if not request.path.endswith("/call"):
                return self.json({"error": "not_found"}, status_code=404)
            body = await request.json()
            if not isinstance(body, dict) or not isinstance(body.get("name"), str):
                return self.json({"error": "invalid_request"}, status_code=400)
            result = await coordinator.api.call(body["name"], body.get("arguments", {}))
            return self.json(result, headers={"Cache-Control": "no-store"})
        except (BridgeError, ValueError):
            return self.json({"error": "upstream_unavailable"}, status_code=502)


async def async_setup(hass, config):
    hass.http.register_view(AulaView())

    async def handle_query(call):
        coordinator = next(iter(hass.data.get(DOMAIN, {}).values()), None)
        if coordinator is None:
            raise HomeAssistantError("Aula Bridge is not configured")
        try:
            result = await coordinator.api.call(call.data["name"], call.data.get("arguments", {}))
            if isinstance(result, dict) and (result.get("error") or result.get("ok") is False):
                raise BridgeError("source_unavailable")
            return {"data": result}
        except (BridgeError, KeyError) as err:
            raise HomeAssistantError("Aula source unavailable; check connection and arguments") from err

    async def handle_snapshot(call):
        coordinator = next(iter(hass.data.get(DOMAIN, {}).values()), None)
        if coordinator is None or not coordinator.last_update_success:
            raise HomeAssistantError("Aula Bridge is unavailable")
        return coordinator.data

    hass.services.async_register(DOMAIN, "query", handle_query, supports_response=SupportsResponse.ONLY)
    hass.services.async_register(DOMAIN, "snapshot", handle_snapshot, supports_response=SupportsResponse.ONLY)
    return True


async def async_setup_entry(hass, entry):
    api = BridgeApi(async_get_clientsession(hass), entry.data["url"], entry.data["token"])
    coordinator = AulaCoordinator(hass, api)
    await coordinator.async_config_entry_first_refresh()
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass, entry):
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unloaded
