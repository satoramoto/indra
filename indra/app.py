"""A small, read-only terminal inventory for Mattermost bot seats."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable


SERVER = "https://mattermost.newegypt.io"
TOKEN_REF = "op://Agent Rig/Mattermost/access_token"
PAGE_SIZE = 100


class InventoryError(Exception):
    """An error safe to show in the terminal without leaking credentials."""


def read_token(reference: str = TOKEN_REF) -> str:
    """Read the existing 1Password secret directly into process memory."""
    try:
        result = subprocess.run(
            ["op", "read", reference], capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        raise InventoryError("1Password CLI is unavailable or timed out.") from None
    if result.returncode:
        raise InventoryError("1Password CLI could not read the existing credential; check its sign-in and vault access.")
    token = result.stdout.strip()
    if not token:
        raise InventoryError("The existing 1Password credential is empty.")
    return token


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward a bearer token to a redirected destination."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


class MattermostAPI:
    def __init__(self, server: str, token: str, opener: Any = None):
        parsed = urllib.parse.urlsplit(server)
        if (
            parsed.scheme != "https"
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise InventoryError("Mattermost server must be an HTTPS origin.")
        self.server = server.rstrip("/")
        self.token = token
        self.opener = opener or urllib.request.build_opener(NoRedirect)

    def get(self, path: str, **params: Any) -> Any:
        query = urllib.parse.urlencode(params)
        url = self.server + "/api/v4" + path + ("?" + query if query else "")
        request = urllib.request.Request(url, method="GET", headers={"Authorization": "Bearer " + self.token})
        try:
            with self.opener.open(request, timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            if status in (401, 403):
                raise InventoryError(
                    f"Mattermost denied read access (HTTP {status}); inventory may be incomplete for this credential."
                ) from None
            raise InventoryError(f"Mattermost read failed (HTTP {status}).") from None
        except (OSError, ValueError):
            raise InventoryError("Mattermost read failed; check connectivity and server response.") from None

    def pages(self, path: str, object_key: str | None = None) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        previous_page_ids: tuple[str, ...] | None = None
        for page in range(1000):
            payload = self.get(path, page=page, per_page=PAGE_SIZE)
            items = payload.get(object_key) if isinstance(payload, dict) and object_key else payload
            if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
                raise InventoryError("Mattermost returned an unexpected inventory response.")
            page_ids = tuple(str(item.get("id", item.get("user_id", ""))) for item in items)
            if len(items) == PAGE_SIZE and page_ids == previous_page_ids:
                raise InventoryError("Mattermost inventory pagination did not advance.")
            found.extend(items)
            if len(items) < PAGE_SIZE:
                return found
            previous_page_ids = page_ids
        raise InventoryError("Mattermost inventory exceeded the pagination limit.")


def role_field(fields: Any) -> dict[str, Any]:
    if isinstance(fields, dict):
        fields = fields.get("fields")
    if not isinstance(fields, list):
        raise InventoryError("Mattermost returned unexpected custom profile field metadata.")
    matches = [f for f in fields if isinstance(f, dict) and str(f.get("name", "")).casefold() == "role"]
    if len(matches) != 1 or not matches[0].get("id"):
        raise InventoryError("A unique custom profile field named Role is not visible to this credential.")
    return matches[0]


def role_options(field: dict[str, Any]) -> dict[str, str]:
    attrs = field.get("attrs") or {}
    options = attrs.get("options") if isinstance(attrs, dict) else None
    if isinstance(options, str):
        try:
            options = json.loads(options)
        except ValueError:
            options = None
    if not isinstance(options, list):
        raise InventoryError("Role field options are unavailable in Mattermost metadata.")
    result = {}
    for option in options:
        if isinstance(option, dict) and option.get("id") and (option.get("name") or option.get("value")):
            result[str(option["id"])] = str(option.get("name") or option["value"])
    return result


def role_values(payload: Any, field: dict[str, Any]) -> list[str]:
    """Resolve deployed field-ID maps and the array form used by some APIs."""
    if isinstance(payload, dict):
        raw = payload.get(field["id"], [])
    elif isinstance(payload, list):
        raw = next((item.get("value", []) for item in payload if isinstance(item, dict) and item.get("field_id") == field["id"]), [])
    else:
        raise InventoryError("Mattermost returned unexpected Role values.")
    if isinstance(raw, str):
        if raw.startswith("["):
            try:
                raw = json.loads(raw)
            except ValueError:
                raise InventoryError("Mattermost returned malformed Role values.") from None
        elif raw:
            raw = [raw]
        else:
            raw = []
    if not isinstance(raw, list):
        raise InventoryError("Mattermost returned unexpected Role values.")
    options = role_options(field)
    return [options.get(str(value), f"Unknown option ({value})") for value in raw]


@dataclass(frozen=True)
class Seat:
    username: str
    display_name: str
    roles: tuple[str, ...]
    role_error: str | None = None


class Inventory:
    def __init__(self, api: MattermostAPI):
        self.api = api

    def teams(self) -> list[dict[str, Any]]:
        return sorted(self.api.pages("/teams"), key=lambda team: str(team.get("display_name") or team.get("name") or "").casefold())

    def seats(self, team: dict[str, Any]) -> list[Seat]:
        if not team.get("id"):
            raise InventoryError("Selected team has no ID in the Mattermost response.")
        bots = self.api.pages("/bots", "bots")
        members = self.api.pages("/teams/" + urllib.parse.quote(str(team["id"]), safe="") + "/members")
        member_ids = {str(member.get("user_id")) for member in members if member.get("user_id") and not member.get("delete_at")}
        field = role_field(self.api.get("/custom_profile_attributes/fields"))
        seats: list[Seat] = []
        for bot in bots:
            user_id = bot.get("user_id")
            if not user_id or str(user_id) not in member_ids or bot.get("delete_at"):
                continue
            username = str(bot.get("username") or user_id)
            display_name = str(bot.get("display_name") or username)
            try:
                payload = self.api.get("/users/" + urllib.parse.quote(str(user_id), safe="") + "/custom_profile_attributes")
                roles = tuple(role_values(payload, field))
                role_error = None
            except InventoryError as exc:
                roles, role_error = (), str(exc)
            seats.append(Seat(username, display_name, roles, role_error))
        return sorted(seats, key=lambda seat: (seat.display_name.casefold(), seat.username.casefold()))


def timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def print_teams(teams: list[dict[str, Any]], refreshed: str, write: Callable[[str], None]) -> None:
    write(f"Connected to {SERVER} | teams refreshed {refreshed}")
    write("Inventory is limited to teams and bots visible to this credential.")
    if not teams:
        write("No teams are visible to this credential.")
    for index, team in enumerate(teams, 1):
        write(f"  {index}. {team.get('display_name') or team.get('name') or '(unnamed)'} ({team.get('name') or 'unknown slug'})")


def print_seats(team: dict[str, Any], seats: list[Seat], refreshed: str, write: Callable[[str], None]) -> None:
    write(f"{team.get('display_name') or team.get('name')} ({team.get('name')}) | seats refreshed {refreshed}")
    write("Connection: Mattermost read succeeded. Agent occupancy: not connected yet.")
    if not seats:
        write("No active bot seats are visible in this team's membership.")
    for seat in seats:
        role_text = ", ".join(seat.roles) if seat.roles else "none"
        if seat.role_error:
            role_text = "unavailable (" + seat.role_error + ")"
        write(f"  {seat.display_name} (@{seat.username}) | Role: {role_text}")


def interactive(inventory: Inventory, read: Callable[[str], str] = input, write: Callable[[str], None] = print) -> int:
    teams: list[dict[str, Any]] = []
    while True:
        try:
            teams = inventory.teams()
            refreshed = timestamp()
            print_teams(teams, refreshed, write)
        except InventoryError as exc:
            write(f"Connection/error: {exc}")
            write("Team list was not refreshed; its previous contents may be stale.")
        choice = read("Team number, [r]efresh, or [q]uit: ").strip().lower()
        if choice == "q":
            return 0
        if choice == "r":
            continue
        if not choice.isdigit() or not 1 <= int(choice) <= len(teams):
            write("Choose a listed team number, r, or q.")
            continue
        team = teams[int(choice) - 1]
        while True:
            try:
                seats = inventory.seats(team)
                print_seats(team, seats, timestamp(), write)
            except InventoryError as exc:
                write(f"Connection/error: {exc}")
                write("Seat inventory is unavailable; no empty-seat conclusion can be drawn.")
            action = read("[r]efresh seats, [b]ack, or [q]uit: ").strip().lower()
            if action == "r":
                continue
            if action == "q":
                return 0
            if action == "b":
                break
            write("Choose r, b, or q.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only Mattermost team and bot-seat inventory")
    parser.add_argument("--team", metavar="SLUG", help="Print one visible team's seats and exit")
    args = parser.parse_args(argv)
    try:
        inventory = Inventory(MattermostAPI(SERVER, read_token()))
        if args.team:
            teams = inventory.teams()
            team = next((team for team in teams if team.get("name") == args.team), None)
            if team is None:
                raise InventoryError(f"Team {args.team!r} is not visible to this credential.")
            print_seats(team, inventory.seats(team), timestamp(), print)
            return 0
        return interactive(inventory)
    except (InventoryError, EOFError, KeyboardInterrupt) as exc:
        if isinstance(exc, InventoryError):
            print(f"Connection/error: {exc}", file=sys.stderr)
        return 1
