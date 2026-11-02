"""One read-only calendar per discovered child."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from homeassistant.components.calendar import CalendarEntity, CalendarEvent
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util
from .const import DOMAIN

ZONE = ZoneInfo("Europe/Copenhagen")


def ordered(events):
    def key(event):
        start = event.start
        if not isinstance(start, datetime):
            start = datetime.combine(start, datetime.min.time(), ZONE)
        return start.timestamp()
    return sorted(events, key=key)


def convert(item):
    start = dt_util.parse_datetime(item.get("startDateTime", ""))
    end = dt_util.parse_datetime(item.get("endDateTime", ""))
    if not start or not end:
        return None
    if start.tzinfo is None:
        start = start.replace(tzinfo=ZONE)
    if end.tzinfo is None:
        end = end.replace(tzinfo=ZONE)
    if item.get("allDay"):
        start, end = start.astimezone(ZONE).date(), end.astimezone(ZONE).date()
        if end <= start:
            end = start + timedelta(days=1)
    return CalendarEvent(start=start, end=end, summary=item.get("title", "Aula"),
                         location=(item.get("primaryResource") or {}).get("name"))


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = hass.data[DOMAIN][entry.entry_id]
    children = coordinator.data.get("manifest", {}).get("children", [])
    async_add_entities([AulaCalendar(coordinator, entry.entry_id, child) for child in children])


class AulaCalendar(CoordinatorEntity, CalendarEntity):
    def __init__(self, coordinator, entry_id, child):
        super().__init__(coordinator)
        self.child = child
        self._attr_unique_id = f"{entry_id}_calendar_{child['id']}"
        self._attr_name = "Aula " + child["name"].split()[0]

    @property
    def available(self):
        return super().available and self.coordinator.data.get("sections", {}).get("calendar", {}).get("status") == "ok"

    @property
    def event(self):
        items = self.coordinator.data.get("sections", {}).get("calendar", {}).get("data") or []
        events = [convert(x) for x in items if self.child["id"] in x.get("belongsToProfiles", [])]
        now = dt_util.utcnow()
        events = [x for x in events if x and (x.end > now if isinstance(x.end, datetime) else x.end >= dt_util.now().date())]
        return next(iter(ordered(events)), None)

    async def async_get_events(self, hass, start_date, end_date):
        def timestamp(value):
            return value.astimezone(ZONE).strftime("%Y-%m-%d %H:%M:%S.0000%z")
        items = await self.coordinator.api.call("aula.calendar.events", {
            "profileIds": [self.child["id"]], "start": timestamp(start_date), "end": timestamp(end_date)})
        return ordered([event for item in items if (event := convert(item)) is not None])
