import { Container, Space } from "@mantine/core";
import HomeTabs from "@/features/home/components/home-tabs";
import HomeHero from "@/features/home/components/home-hero";
import SpaceCarousel from "@/features/space/components/space-carousel.tsx";
import { useTranslation } from "react-i18next";
import { DocumentTitle } from "@/components/ui/document-title.tsx";

export default function Home() {
  const { t } = useTranslation();

  return (
    <>
      <DocumentTitle title={t("Home")} />
      <Container size={"900"} pt="xl">
        <HomeHero />

        <Space h="xl" />

        <SpaceCarousel />

        <Space h="xl" />

        <HomeTabs />
      </Container>
    </>
  );
}
