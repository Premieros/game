# BlastKart 3D — Browser Rocket Racing MVP

نسخة أولى قابلة للعب من لعبة سباق Arcade للمتصفح.

## الموجود حاليًا
- Solo: لاعب واحد + 9 Bots.
- Online matchmaking: حتى 10 لاعبين حقيقيين، وأي أماكن فارغة تتحول Bots تلقائيًا.
- Private Room: كود غرفة للأصدقاء.
- 3 لفات + ترتيب مباشر 1/10.
- Power-ups: صاروخ موجه خفيف، Nitro، Shield.
- Bots تقود وتلتقط الأسلحة وتستخدمها.
- اصطدامات بين السيارات.
- تحكم كمبيوتر: WASD/الأسهم + Space.
- تحكم موبايل بأزرار لمس.
- السيرفر هو الذي يحسب حالة السباق ويرسلها للجميع.
- بدون مكتبات خارجية أو npm install.

## التشغيل
يتطلب Node.js 18+ (يفضل Node 22).

### Windows
شغّل `START_WINDOWS.bat` ثم افتح:
`http://localhost:8787`

### macOS / Linux
```bash
PORT=8787 node server.js
```
ثم افتح `http://localhost:8787`.

## Multiplayer
لكي يلعب أشخاص من أجهزة مختلفة يجب تشغيل السيرفر على استضافة عامة تدعم WebSocket أو على جهاز متاح لهم عبر الشبكة.

## ملاحظات MVP
هذه النسخة هدفها اختبار متعة السباق، التحكم، الـBots، والأسلحة. الخطوة التالية المناسبة: جرافيك 3D/2.5D أقوى، Drifting، خرائط متعددة، أصوات، حسابات، بطولة وترتيب دائم.

## 3D renderer
The client now uses native WebGL for a true third-person 3D track, 3D karts, scenery, pickups and rockets without external CDN dependencies.
