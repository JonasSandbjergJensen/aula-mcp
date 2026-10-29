"""One coordinated refresh, with per-source stale/error states preserved."""
from datetime import timedelta
import logging
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from .api import BridgeError


class AulaCoordinator(DataUpdateCoordinator):
    def __init__(self, hass, api):
        super().__init__(hass, logging.getLogger(__name__), name="Aula",
                         update_interval=timedelta(minutes=10))
        self.api = api

    async def _async_update_data(self):
        try:
            return await self.api.request("snapshot")
        except BridgeError as err:
            raise UpdateFailed(str(err)) from err
