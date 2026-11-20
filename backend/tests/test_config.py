"""The .env against the environment: what is set for this run wins, what only Windows' settings
hold does not (an expired HF_TOKEN left there hid the new one in the .env)."""

import pytest

from app import config


@pytest.fixture()
def dotenv(tmp_path, monkeypatch):
    backend = tmp_path / "backend"
    backend.mkdir()
    monkeypatch.setattr(config, "BACKEND_DIR", backend)
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path)

    def write(text: str, system: dict[str, str] | None = None) -> None:
        (tmp_path / ".env").write_text(text, encoding="utf-8")
        monkeypatch.setattr(config, "_system_env", lambda key: (system or {}).get(key))

    return write


def test_the_dotenv_beats_a_stale_windows_variable(dotenv, monkeypatch, caplog):
    monkeypatch.setenv("FORMA_TEST_TOKEN", "hf_old")
    dotenv("FORMA_TEST_TOKEN=hf_new\n", system={"FORMA_TEST_TOKEN": "hf_old"})
    config._load_dotenv()
    assert config.os.environ["FORMA_TEST_TOKEN"] == "hf_new"
    assert "FORMA_TEST_TOKEN" in caplog.text and "hf_" not in caplog.text  # named, never shown


def test_the_dotenv_beats_an_old_copy_handed_down_before_windows_changed(dotenv, monkeypatch):
    """VS Code started before the setting was updated: its terminals still carry the old token."""
    monkeypatch.setenv("FORMA_TEST_TOKEN", "hf_old")
    dotenv("FORMA_TEST_TOKEN=hf_new\n", system={"FORMA_TEST_TOKEN": "hf_new"})
    config._load_dotenv()
    assert config.os.environ["FORMA_TEST_TOKEN"] == "hf_new"


def test_a_variable_set_for_this_run_beats_the_dotenv(dotenv, monkeypatch):
    """`GEN_PROVIDER=procedural make ...`, the e2e flows, the tests: not in Windows' settings."""
    monkeypatch.setenv("FORMA_TEST_PROVIDER", "procedural")
    dotenv("FORMA_TEST_PROVIDER=local\n", system={})
    config._load_dotenv()
    assert config.os.environ["FORMA_TEST_PROVIDER"] == "procedural"


def test_an_empty_dotenv_value_never_erases_one_from_windows(dotenv, monkeypatch):
    monkeypatch.setenv("FORMA_TEST_KEY", "abc")
    dotenv("FORMA_TEST_KEY=\n", system={"FORMA_TEST_KEY": "abc"})
    config._load_dotenv()
    assert config.os.environ["FORMA_TEST_KEY"] == "abc"


def test_a_missing_variable_comes_from_the_dotenv(dotenv, monkeypatch):
    monkeypatch.delenv("FORMA_TEST_NEW", raising=False)
    dotenv('FORMA_TEST_NEW="valore"\n')
    config._load_dotenv()
    assert config.os.environ["FORMA_TEST_NEW"] == "valore"
    monkeypatch.delenv("FORMA_TEST_NEW")
