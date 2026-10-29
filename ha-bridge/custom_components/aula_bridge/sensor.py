"""Small status entities. Message bodies are never stored in sensor attributes."""
from homeassistant.components.sensor import SensorEntity
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from .const import DOMAIN


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = hass.data[DOMAIN][entry.entry_id]
    keys = ["connection", *coordinator.data.get("sections", {}).keys()]
    async_add_entities([AulaStatus(coordinator, entry.entry_id, key) for key in keys])


class AulaStatus(CoordinatorEntity, SensorEntity):
    _attr_icon = "mdi:school"

    def __init__(self, coordinator, entry_id, key):
        super().__init__(coordinator)
        self.key = key
        self._attr_unique_id = f"{entry_id}_{key}"
        self._attr_name = f"Aula {key}"

    @property
    def native_value(self):
        if self.key == "connection":
            return "ok" if self.coordinator.last_update_success else "unavailable"
        return self.coordinator.data.get("sections", {}).get(self.key, {}).get("status", "unknown")

    @property
    def extra_state_attributes(self):
        section = self.coordinator.data.get("sections", {}).get(self.key, {})
        return {"last_fetched": section.get("fetched_at", self.coordinator.data.get("fetched_at")),
                "stale": section.get("stale", False), "coverage": section.get("coverage")}
