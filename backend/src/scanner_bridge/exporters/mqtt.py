from __future__ import annotations

import json
from typing import Any


class MqttExporter:
    def __init__(self, host: str, port: int, topic_prefix: str, qos: int, retain: bool):
        try:
            import paho.mqtt.client as mqtt
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("paho-mqtt is required for MQTT exporter") from exc
        self._client = mqtt.Client()
        self._client.connect(host, port, keepalive=60)
        self._client.loop_start()
        self._prefix = topic_prefix.rstrip("/")
        self._qos = qos
        self._retain = retain

    def publish(self, topic: str, payload: Any) -> None:
        full_topic = f"{self._prefix}/{topic.lstrip('/')}"
        data = json.dumps(payload, separators=(",", ":"))
        self._client.publish(full_topic, data, qos=self._qos, retain=self._retain)

    def close(self) -> None:
        self._client.loop_stop()
        self._client.disconnect()
