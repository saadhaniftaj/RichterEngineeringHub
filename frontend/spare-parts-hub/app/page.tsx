"use client";

import { useState } from "react";
import UploadZone from "@/components/UploadZone";
import SearchCenter from "@/components/SearchCenter";
import DocsList from "@/components/DocsList";

type Tab = "search" | "upload" | "docs";

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<Tab>("search");
  const [lang, setLang] = useState<"EN" | "DE">("EN");

  const texts = {
    EN: {
      title: "Spare Parts Hub",
      subtitle: "Internal document extraction and search tool.",
      searchTab: "Search",
      uploadTab: "Upload",
      docsTab: "Documents",
      footer: "© 2026 Richter Engineering GmbH. Internal Use Only. Developed by Vanguard Solutions."
    },
    DE: {
      title: "Ersatzteil-Hub",
      subtitle: "Internes Tool zur Dokumentenextraktion und -suche.",
      searchTab: "Suche",
      uploadTab: "Hochladen",
      docsTab: "Dokumente",
      footer: "© 2026 Richter Engineering GmbH. Nur für den internen Gebrauch. Entwickelt von Vanguard Solutions."
    }
  };

  const t = texts[lang];

  return (
    <>
      {/* Animated SVG Wave Background */}
      <svg
        style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", zIndex: 0, opacity: 0.6 }}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 1440 320"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="gradient1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style={{ stopColor: "#dc2626", stopOpacity: 0.15 }} />
            <stop offset="100%" style={{ stopColor: "#991b1b", stopOpacity: 0.05 }} />
          </linearGradient>
          <linearGradient id="gradient2" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style={{ stopColor: "#fca5a5", stopOpacity: 0.15 }} />
            <stop offset="100%" style={{ stopColor: "#dc2626", stopOpacity: 0.05 }} />
          </linearGradient>
        </defs>
        <path fill="url(#gradient1)">
          <animate
            attributeName="d"
            dur="20s"
            repeatCount="indefinite"
            values="M0,160 C320,300,420,300,740,160 C1060,20,1120,20,1440,160 V320 H0 V160 Z;
                    M0,100 C320,20,420,20,740,100 C1060,180,1120,180,1440,100 V320 H0 V100 Z;
                    M0,160 C320,300,420,300,740,160 C1060,20,1120,20,1440,160 V320 H0 V160 Z"
          />
        </path>
        <path fill="url(#gradient2)">
          <animate
            attributeName="d"
            dur="15s"
            repeatCount="indefinite"
            values="M0,100 C320,180,420,180,740,100 C1060,20,1120,20,1440,100 V320 H0 V100 Z;
                    M0,160 C320,300,420,300,740,160 C1060,20,1120,20,1440,160 V320 H0 V160 Z;
                    M0,100 C320,180,420,180,740,100 C1060,20,1120,20,1440,100 V320 H0 V100 Z"
          />
        </path>
      </svg>

      <nav>
        <div className="nav-content">
          <div className="logo">
            <img src="/logo.png" alt="Richter Engineering Logo" style={{ height: '55px', objectFit: 'contain' }} />
          </div>
          <div className="nav-links">
            <a
              className={activeTab === "search" ? "active" : ""}
              onClick={() => setActiveTab("search")}
            >
              {t.searchTab}
            </a>
            <a
              className={activeTab === "upload" ? "active" : ""}
              onClick={() => setActiveTab("upload")}
            >
              {t.uploadTab}
            </a>
            <a
              className={activeTab === "docs" ? "active" : ""}
              onClick={() => setActiveTab("docs")}
            >
              {t.docsTab}
            </a>
            
            <div className="lang-toggle ml-4">
              <span 
                className={lang === "EN" ? "active" : "text-gray-500 hover:text-gray-800"} 
                onClick={() => setLang("EN")}
              >EN</span>
              <span className="text-gray-400">|</span>
              <span 
                className={lang === "DE" ? "active" : "text-gray-500 hover:text-gray-800"} 
                onClick={() => setLang("DE")}
              >DE</span>
            </div>
          </div>
        </div>
      </nav>

      <section className="hero">
        <h1 className="glare-red-text">{t.title}</h1>
        <p>{t.subtitle}</p>
      </section>

      <div className="container" style={{ paddingBottom: '1rem', minHeight: '50vh' }}>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 sm:p-8 min-h-[250px]">
          {activeTab === "search" && <SearchCenter lang={lang} />}
          {activeTab === "upload" && <UploadZone lang={lang} />}
          {activeTab === "docs" && <DocsList lang={lang} />}
        </div>
      </div>

      <footer style={{ background: 'var(--card-white)', textAlign: 'center', padding: '1rem 0', borderTop: '3px solid var(--red-primary)', position: 'relative', zIndex: 1, marginTop: '20vh' }}>
        <div className="container">
          <div style={{ color: 'var(--text-light)', fontSize: '0.9rem' }}>
            {t.footer}
          </div>
        </div>
      </footer>
    </>
  );
}
