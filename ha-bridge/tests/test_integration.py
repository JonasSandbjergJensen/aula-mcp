"""Focused client/calendar checks without pretending to run Home Assistant."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1] / "custom_components" / "aula_bridge"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


api = load("bridge_api_test", ROOT / "api.py")


class ApiTest(unittest.IsolatedAsyncioTestCase):
    def test_url_validation(self):
        self.assertEqual(api.validate_url("https://example.com/"), "https://example.com")
        for value in ["http://example.com", "https://user:secret@example.com", "https://example.com/path",
                      "https://example.com/?token=secret", "file:///etc/passwd"]:
            with self.assertRaises(ValueError, msg=value):
                api.validate_url(value)

    async def test_redirects_never_receive_the_gateway_key(self):
        class Response:
            status = 302
            async def __aenter__(self): return self
            async def __aexit__(self, *_): return None
        class Session:
            def request(self, method, url, **kwargs):
                self.kwargs = kwargs
                return Response()
        session = Session()
        client = api.BridgeApi(session, "https://example.com", "test-secret")
        with self.assertRaises(api.BridgeError):
            await client.request("snapshot")
        self.assertIs(session.kwargs["allow_redirects"], False)


# Stub only the HA types used by calendar conversion. No HA runtime is emulated.
for name in ["homeassistant", "homeassistant.components", "homeassistant.components.calendar",
             "homeassistant.helpers", "homeassistant.helpers.update_coordinator",
             "homeassistant.util", "aula_test_package"]:
    sys.modules[name] = types.ModuleType(name)


@dataclass
class CalendarEvent:
    start: object
    end: object
    summary: str
    location: str | None = None


sys.modules["homeassistant.components.calendar"].CalendarEvent = CalendarEvent
sys.modules["homeassistant.components.calendar"].CalendarEntity = type("CalendarEntity", (), {})
sys.modules["homeassistant.helpers.update_coordinator"].CoordinatorEntity = type("CoordinatorEntity", (), {})
sys.modules["homeassistant.util"].dt = types.SimpleNamespace(
    parse_datetime=lambda value: datetime.fromisoformat(value) if value else None,
    utcnow=lambda: datetime.now(timezone.utc),
    now=lambda: datetime.now(ZoneInfo("Europe/Copenhagen")),
)
load("aula_test_package.const", ROOT / "const.py")
calendar = load("aula_test_package.calendar", ROOT / "calendar.py")


class CalendarTest(unittest.TestCase):
    def test_all_day_has_exclusive_next_day_end(self):
        item = {"title": "School event", "allDay": True,
                "startDateTime": "2026-10-30T00:00:00+01:00",
                "endDateTime": "2026-10-30T00:00:00+01:00"}
        event = calendar.convert(item)
        self.assertEqual(event.start.isoformat(), "2026-10-30")
        self.assertEqual(event.end.isoformat(), "2026-10-31")

    def test_offsetless_aula_time_is_danish_and_mixed_events_sort(self):
        event = calendar.convert({"title": "Meeting", "startDateTime": "2026-07-01T12:00:00",
                                  "endDateTime": "2026-07-01T13:00:00"})
        self.assertEqual(event.start.utcoffset().total_seconds(), 7200)
        all_day = CalendarEvent(event.start.date(), event.end.date(), "All day")
        self.assertEqual(calendar.ordered([event, all_day])[0].summary, "All day")

    def test_missing_dates_are_not_events(self):
        self.assertIsNone(calendar.convert({"title": "No date"}))


if __name__ == "__main__":
    unittest.main()
