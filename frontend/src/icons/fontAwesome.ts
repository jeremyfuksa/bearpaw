import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faUsb } from "@fortawesome/free-brands-svg-icons";
import { faRotate } from "@fortawesome/free-solid-svg-icons";

export const byPrefixAndName: {
  fab: Record<string, IconDefinition>;
  fas: Record<string, IconDefinition>;
} = {
  fab: {
    usb: faUsb,
  },
  fas: {
    rotate: faRotate,
  },
};
