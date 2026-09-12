import React from "react";
import { Group } from "@mantine/core";
import classes from "./auth.module.css";

type AuthLayoutProps = {
  children: React.ReactNode;
};

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <>
      <Group justify="center" gap={8} className={classes.logo}>
        <img
          src="/logos/patty_kb_text_logo.png"
          alt="Patty KB"
          height={48}
          style={{ objectFit: "contain", maxWidth: 260 }}
        />
      </Group>
      <main>{children}</main>
    </>
  );
}
