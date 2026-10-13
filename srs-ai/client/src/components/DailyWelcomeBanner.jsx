import { useEffect, useState } from "react";
import { dailyBannerImages, getDailyBannerIndex } from "../data/dailyBannerImages.js";

const dailyMessages = [
  "Every great product starts with a clear requirement.",
  "Small steps today lead to software your team can trust.",
  "Turn your next idea into a plan your team can build.",
  "Clear requirements make ambitious ideas achievable.",
  "Keep moving forward; every detail brings your project into focus.",
  "A thoughtful plan today makes a smoother build tomorrow.",
  "Your next great project begins with one clear idea."
];

const fallbackImage = dailyBannerImages[0];

export default function DailyWelcomeBanner({ userName, onCreateProject }) {
  const [today, setToday] = useState(() => new Date());
  const [failedImageId, setFailedImageId] = useState(null);

  useEffect(() => {
    const timer = window.setInterval(() => setToday(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const firstName = userName.trim().split(/\s+/)[0] || "there";
  const greeting = today.getHours() < 12 ? "Good morning" : today.getHours() < 18 ? "Good afternoon" : "Good evening";
  const dayIndex = Math.floor(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86_400_000);
  const image = dailyBannerImages[getDailyBannerIndex(today)];
  const displayImage = failedImageId === image.id ? fallbackImage : image;
  const imageFailed = failedImageId === fallbackImage.id;
  const dateLabel = today.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const message = dailyMessages[dayIndex % dailyMessages.length];

  return (
    <section className="daily-banner" aria-label="Daily welcome">
      <div className="daily-banner-copy">
        <div className="daily-banner-card">
          <p className="daily-banner-date">{dateLabel}</p>
          <h1>{greeting}, {firstName}.</h1>
          <p className="daily-banner-message">{message}</p>
          <button className="primary-btn" onClick={onCreateProject}>＋ New project</button>
        </div>
      </div>
      <div className="daily-banner-photo">
        {!imageFailed && (
          <img
            key={displayImage.id}
            src={displayImage.src}
            alt={displayImage.alt}
            width="960"
            height="480"
            loading="eager"
            decoding="async"
            onError={() => setFailedImageId(displayImage.id)}
          />
        )}
        <span className="daily-banner-photo-label">{displayImage.category}</span>
      </div>
    </section>
  );
}
