"""Configure a separate gateway key, never an Aula or OpenAI token."""
from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import selector
try:
    import probatio as vol
except ImportError:
    import voluptuous as vol
from .api import BridgeApi, BridgeError, validate_url
from .const import DOMAIN


class AulaFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors = {}
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            try:
                url = validate_url(user_input["url"])
                if len(user_input["token"]) < 32:
                    raise BridgeError("invalid_auth")
                api = BridgeApi(async_get_clientsession(self.hass), url, user_input["token"])
                result = await api.request("status")
                if not result.get("ok"):
                    raise BridgeError("cannot_connect")
                return self.async_create_entry(title="Aula", data={**user_input, "url": url})
            except BridgeError as err:
                errors["base"] = str(err)
            except ValueError:
                errors["base"] = "invalid_url"
        return self.async_show_form(step_id="user", data_schema=vol.Schema({
            vol.Required("url"): str,
            vol.Required("token"): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)),
        }), errors=errors)
