/* Small, native-button interactions for the homepage. */
(function () {
  'use strict';

  const copyButton = document.querySelector('button[data-copy-email]');
  const copyStatus = document.querySelector('[data-copy-status]');

  if (copyButton && copyStatus) {
    let latestAttempt = 0;
    let fadeTimer;
    let clearTimer;

    const resetStatus = () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(clearTimer);
      copyStatus.classList.remove('is-fading');
      copyStatus.replaceChildren();
    };

    const showSuccessStatus = () => {
      const message = document.createElement('span');
      message.className = 'copy-status-message';
      message.textContent = 'copied! your move, ';
      const emphasis = document.createElement('span');
      emphasis.className = 'copy-status-emphasis';
      emphasis.textContent = 'stranger...';
      copyStatus.replaceChildren(message, emphasis);
      copyStatus.classList.remove('is-fading');
      fadeTimer = window.setTimeout(() => copyStatus.classList.add('is-fading'), 1800);
      clearTimer = window.setTimeout(resetStatus, 6800);
    };

    copyButton.addEventListener('click', async () => {
      const attempt = ++latestAttempt;
      resetStatus();

      try {
        await navigator.clipboard.writeText(copyButton.dataset.copyEmail);
        if (attempt === latestAttempt) {
          showSuccessStatus();
        }
      } catch (_error) {
        if (attempt === latestAttempt) {
          copyStatus.textContent = 'Select the address above to copy it.';
        }
      }
    });
  }

  // Hovering “excursions” plays a short, non-looping audio excerpt, fading in
  // and out smoothly; moving the pointer away fades it out and stops, and the
  // file’s own abrupt ending dissolves into silence instead of cutting.
  const excursionTrigger = document.querySelector('.excursion-trigger');
  if (excursionTrigger) {
    const PEAK_VOLUME = 0.35;
    const FADE_IN_MS = 600;
    const FADE_OUT_MS = 1500;
    const TAIL_FADE_MS = 1500;

    // Eleven 32×32 frames of the original .ani, baked in as data URLs.
    // Browsers can't animate a cursor image, and swapping the CSS cursor
    // per frame is unreliable too: the OS cursor is only refreshed lazily
    // (on pointer activity) and the frames re-decode through a cache that
    // evicts them, so repeat plays land frames late or out of order and
    // the spin reads as jumps. Instead the system cursor hides while the
    // excerpt plays (see css/cursor.css) and the frames are painted on a
    // small overlay that tracks the pointer, stepped off the rAF clock so
    // every frame lands exactly once, in order.
    const MUSICAL_FRAMES = [
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAABRUlEQVR4nO2Wu4qDQBSGfSdfIo3voG9hlyKNtZ1VAmJ6IwQihHSaToiKaOENu4ApLf9lZFlcbxujYZdlPjjgDL+HbwbhyDAUyl8DI8zJThK43+84n8/Ybrc4HA6I47i3MVlXVYXb7QZN06CqKq7X6zwJANB1nbz8rQzD6DQmz47jQBCErxzLsthsNq9LAKhP0xYg5bpuR8CyLHAc18nKsvy6gG3b4Hm+V6ItQJAkaTA7WQKfXC4XiKKI1Wo1KNDMK4rSEYii6PVbIBRFUd+GaZrY7/e9As2853n1x3s8HutskiS9+UkSzeZDAn15spXn+WB+sozv+6MC7TwVYKgAQwWY3xfIsuw9As9AsmmaLifgum7ddL1e/1hkhsyaBW1IkyAIeifeWIVhuJxAWZb1j8put3uqTqcTHo/HcgJzmC1AofxrPgB2Ujo/qTIMnQAAAABJRU5ErkJggg==",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAC90lEQVR4nO2WS0gqYRTHlTKEyI2LNu0iKSwCiahFBIIRRssWgQsXQVBk1CJok0FEq5bRA0Jx4aZNq9pEUC0ECyOCIKSgsvdrjLR3/8s5zBdT6m26aXKhHwwzzsx3/sfz+kaj+eV/BQqyKq7kx4Tj8Th2dnZwdHSE8/Nz3NzcZN4RyEQiEUxOTsJisaCqqgqFhYXo7OzExcUFXl5eMuMAZGKxGKanp0kg4airq8P+/n5mogAZCvfQ0BAqKioSHCgqKoLL5cLt7e33HYBsQGmIrp+fnxEOhzE2NoampiZUVlaivLwcs7Oz/O8pHcFgkN/7JyeQgo/P7+/v8fj4iKurK5ycnODh4YHvh0IhlJSU4PLy8uupgMz19TVOT09xfHyMp6cnPpQR+ZuTdO7v78fw8DB3iioHIENCFL7BwUHo9XqYTCYUFxdjZGQEr6+vCcZSpYmE6XJra0tdV0AW39jYQHV1ddIKn5qaUh1Oem9paYltSZL0eSogs7i4CKPR+Caq1Wr5bDAYOCKixdRGtK2tDRMTE1wvqqIgSRJXd2trK8xmM5qbm9He3o65uTmMj4/DZrOpLixRSzk5Odjd3U2awqSLzs7OcHBwgPX1dWxubvJvWkxTzm63Y2Zm5kupoPZsbGxENBpVnwqBKCBxTQ7pdDp2hlDjAGG1WuH3+3F3d/f5OnxAeZ/GMKXI4XAkPE9mhyJHXdXS0oL8/HzevD5blxKxkOZDTU0NFhYWkhoS79FwGh0dRX19PRdyV1cX9vb21NVCKmghjdi1tTU2qpz5QpjaeXl5GR0dHSgoKOBiphZO2yYFgPd+2pB6e3vfpYtE3G43b9G5ubno6elBIBB4y/23xQlh6PDwEKWlpVhdXeU+n5+fh9PpRF5eHmpra+HxeHiUp01YCRmkjWhlZYX7vK+vD2VlZVxoAwMD3ML0PCPiAjG4uru7uR4aGhrg9Xr5eyGjwgIhQkPL5/Nhe3v73dzQ/ASQB5T4+PgxYSVZExZkVfwXTZr4AxXTO4tXc8YRAAAAAElFTkSuQmCC",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAC2UlEQVR4nO1VzUvqURDVokiJolXQJnRpZJs21a4ggraVC1246V+IDG0vVBREQUGbWkUUiKtAiEpQQdAihRRTrBZZaR/mV3YeM6So9eqnr3wbD1z8ee/cO+fMnZkrEtVQQwUAAFG1Hf4NVXP+9vaGu7s7RKNRvL6+IpFI/D4RvDt+enrCwsICRkdH0dLSgv7+fiwtLeHq6up3iQBgJ1NTU5DL5XQ4j4aGBigUCjQ1NWFmZgbBYBDxeJzJ/hgRvGNnZ4cd5pzTmJycxM3NDUdmbW2N57RaLbxeL89ls9l/jwoAVrWysgKJRMJO6urq+NdmsxWpzWQy2NvbQ3t7O4aHh3n94eGB5ysigoKDNzc3MTY2BrVajfX1dQQCgfy9l9oTjo+PMTAwAKVSCZPJhNvbWySTyfKIoACkxO/3IxKJfFuChWsejwcajQYdHR0cRaqgXNTKjkQphO6jfKDoUQ4dHBwI3v8BlWwke6vVytUyPj6OcDgs/AyUqfiz/alUikuU/m5sbOQroyzH8Qprm2xdLhf6+vowODgIn88nbD8AzvCLiwssLi5y5jc2NmJ7e5sVCSFC66R2dnYWYrEYq6urSKfTwtRns1kcHh4WNR0avb29fBi131gs9iURmj8/P8fIyAh6enpwcnIiXH0oFMLExETeMTmldms2m3F6egq9Xg+pVIrp6WlcXl5+yJPc9/z8PGf+3NwcXl5ehN/9/v4+6uvri5QbjUauYcLz8zM3ouXlZa5vuqKzs7MiIpTtKpUKnZ2dsNvtwtVnMhmuVZlMhubmZg6fTqfjcJaC8uT6+ppzo7u7mzvf0dERr21tbfGLaTAY8tcliEBOodPpxO7uLtxuN+7v7/ntJ5TaEigx6VGyWCwYGhpCa2srurq60NbWxnM5fEvgs4NLISpB4RqRJLIOh4PbL+VI7tpElQBfOP7Knqro8fGRR1nqfwrfRa1qwP8mUEMNojLwB2p7RpLPKDRNAAAAAElFTkSuQmCC",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAACwUlEQVR4nO2Wv0tyURzGy0GTUFwcXPoHKkg3hxAaJBBxCsHFSYKWokkHuVtGi1vQIBgUIQRFOjRIv6gUcYhSiSZREqP8VakV6fPyPXglevvhvW/5wvv2wB3kes7nOed8n++5PT0/+tG/LLTUFchH+nZIo9HA09MTarUabm9vcXV1hYuLC1Sr1T8zgDcg9Xodd3d3KJVKyGQySCaTCAaD8Hg8sFqtGBwcRH9/P0Gxvb0t3gBe6OTkBKFQCAsLC7DZbBgeHoZCoWCQsbExuFwurK6uIhaLIZfLYWlpCVKpFIuLi8y4YBNoaX9/H3K5nIEGBgawvLyMaDSKy8tLPDw8vHske3t70Gg04DiOHYsgA2iJttZgMDA4PV6v9zfoe+NTqRS0Wi3sdjsKhYJwA7VaDSsrK1Cr1W0DMzMzuL+//3Qyek/HYDabMTo6inQ6LdxAuVzG5OQkJBIJg/f29rIiowLsxAAlweFwsGM7PT0VtwMcx7VXr9PpcH5+3lGu6f3z8zOcTif6+vqws7Mj3ECj0UA4HMbExAQsFgu2trY6gr+cg1+A3+8XV4SFQgEHBwc4OjoSBOfnWFtbg0wmExdFAGg2m+2BYgyQeYqi2+0WH0VeQv7Li6JItSMqip1CeNEKqS0fHh7C5/NhenoaQ0NDrAaohq6vr8UZwAtRBLPZLI6Pj1lhzc7OQq/XM4hKpcLIyAhr0/Pz89jc3EQ8HmfJubm5YXeIYANoiSIVCAQYiPr7+Pg45ubmsLGx0Ybk83kUi0XWqKhb0pi3JBjebDZZCvh+QAaoz38EEQV8LX4C6mj8ZUSPUqnE7u7u10A+EwCcnZ2xbsYbMJlM7DaknflWOIkAiUSC9XP6SffC1NQUK6quGcjn8zAajcwA3WwUM/5C6oqBx8dH9pWzvr6OSCSCSqXSHfjrJHxZdQsR/ga053/ULxLBOyUZf7SlAAAAAElFTkSuQmCC",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAC+ElEQVR4nO1WPUhyURg2A4fMQIKGpAhbggYbWlxyk2iKIhuLoiWCoCG3EMLBsQKhwakgcRHaChKztVr6gaKfISoUyn/zr56P9+Wei0X5eVNr6YEL1+M57/Oc9zzve65K9YcaAAB+lVzg18hzudzPiwCA19dXPD4+Yn19HTc3Nz8nAgCKxSJub28xMDCAhoYGzM7O4vr6ur4iICGfz+Pq6grd3d1wuVyYm5sjQjgcDtzf39dHACRks1kcHh5Cp9Nhb2+Pxy4vLzE9Pc2ZWFlZwfPzc21FQEI6ncb29jYTnZycoBRHR0cYGRlBU1MTPB4PUqlUbURAQjKZxNraGgwGAx4eHt4FF3MoIxaLBe3t7djc3JSro2ryaDSKhYUFDA4OfrkzGnt7e4PP50Nvby9MJhMLorFviYBUZuFwGMPDw5ifn+ff5YIJg5IPKFNWq5X9oqgyUOJ0Kqu+vj4OWGkQcVxLS0tobm7GxMQEl6tiEel0Gm1tbZz2RCKhKI00NxKJYHJyksvz4OAAhUKhMhGQWuvY2Bgvpl3s7OxUbChBcn5+zus3NjYQj8crzwAkAT09PRyAHqPRiKenp/8GEf8Hg0Eux0AgwMehiJxAfX1oaEgW0NXVhYuLCwiUW0vl19HRgePjY7y8vJRd82UQOvPR0VGo1WoWoNFoynY3sc7pdMJsNuPs7IxNrIhcgBaQYejsWltbodVqYbPZ5ObzMaCYPzU1xfPu7u74olJMXAqRBWoqMzMz2Nra+tRI9B6LxXjXdrudnf+tXX8GCpLJZDgokXxGTvXd2NgIt9stH1FNyAkimGilIrB4pw5H5GQ60SdqRi4gR/1AHgqF2Jx6vR5+v182nKregHQ/eL1euUT7+/txenr6/UtHCYiAantxcfGdAPIA+aUux1AKQTA+Pi4LoGd5eVmuElU9AeljdH9/n+8IGmppaeGMVF37lULU/urqKnfKzs5O/kxT3HarAQC+nKgCdnd35fOvO7GqRACBbs0fcX85EdWS/wNiSTn/n4HZtAAAAABJRU5ErkJggg==",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAC6klEQVR4nO2WzUtyQRTGCyVqYwuLSFDX/QFGEJHtgna5kSARV+GihSB9EBK4aBdu2hVFYNS6AmljbvxYiGRt8gOxQqPUQvvSyuflDN77qllJ99bLCz1wucOduXN+c2bOOdPS8qv/RQDwzwGq9ePGy+UyHh4eUCgUWPtHYQDg/v4eS0tLmJ2dxerqKgKBAFKpFEqlUg3MtwABQCaTQW9vLxQKBRlAd3c3dDodlpeXsb+/j2g0yrwjOgwqOj09hVKphNvtxuLiIqampqDRaNDR0YG2tjYMDAxgfn4eGxsbCIVCyGazNVslCKBUKmFlZQUOh4OfMJ/P4+TkBE6nEzMzMxgbG0NPTw/zjlqthtlsxtXVlTgAd3d3bIWRSASNVCwWkUwmcXBwAJvNhvHxccjlclxeXgo3Tjo7O0Nrayvv0vfGcdre3obRaOTPhCCA19dXuFwu5tJmJqMxBoMBe3t7eHl5EQ7w+PiIyclJHB4efjoZ9ZNRiUSCWCzGe0QQQC6XQ2dnJzsHzQAcHx9jaGgINzc3wo2Xy2WEw2EMDg427X5KVhQxdDAFAxSLRdjtdhbbzayeRKF4dHQkjvvz+Tz6+vpwfn7+6YTUR2FHOYCLf0HGSfF4nCUWehPMR5mNvu3s7MBisbC6IUr4+f1+BkBemJubY/ngI4DR0VEWLfSvYADS5uYmA+AerVbbEIILV6oLXP+XjXOiSTweD9rb22sgKMs9PT29AfD5fBgeHkYikeATUD1o00JFz8/PrNCoVCoeQK/X15RdbrzVakVXVxdMJhMrz3RXoP8FQ9ze3jIIuguQgenpaVxcXNQYr7T5Z2RkhJVmrhh9eUtQOYzX19cIBoPsLkAxTvtdDUAr3draqoGQyWRYW1sTpx5Uqz4UuXY6nUZ/fz8PIJVKMTExIbwkV6sapP47ge3u7rKQ5SAWFhZY/hAN4D1xUJS66W64vr7O6oHX620I/C1CnQiGuzF/u/HPYN4M+FXLX/0BK7pAOEHvVIMAAAAASUVORK5CYII=",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAC3UlEQVR4nO1WPUhyYRTOhNApAqlFyFUxQhAkokmIMGpqVXFpaAxqCEzCwdEhIt0MKnBocAgrFVxEcBDtZ4qKCiVKM7Uos3o+zovK/bT0mvfrW3rgci/3fd97nvPznHO7un7xC4GACv6L0Xr8mMHX11ek02kkEgmcnJygXC4LTwB1KBaLOD09xe7uLpxOJ2ZmZtDf3w+1Wo1sNts5AdTh7e0Nt7e3zEuPx4OlpSWMjIygp6cHEokEWq0Ws7OzZBRHR0edpwEVlEolZnR9fR0WiwUKhYIZGRgYgMFgwOLiIjY3N3F8fIxCoYCFhQVsbW2xtAgShbu7O8hkMojFYqhUKpjNZiwvLyMQCODy8pIR5CIajWJ6ehr5fF4YAoVCARMTE8xwLBZDJpP5strp+fn5GVKpFFdXV8IQKJfL2N7ehtVq5SUxWiPC4XAY7+/vwtTBxcUFuru7eRUWrXu9XszPz+Pp6Um4NCiVSlxfX/MicHNzg8HBQaYaQQiUSiXY7XYmPz4ECKSSZDIpjBw/Pj5weHiI0dFRXh+jPQ6HA2traw0q+RYhALi/v0dvby8eHx95RYGa0djYGHK5XK2fvLy8fI8EKvIyGo2suvkQoM5JvcPn8+Hg4AA7OzvY2Nhgs4LW2iIBgElqb28Pc3NztYPNPkLvTSZTrXMODQ1heHgY4+PjcLvdeHh4aI8AgZqLSCRiNfEVuGeIMD1yL5KzXC5nNcXd3xK0mfKv0+lYu6VJSPezs7Pa9OOSqE5Mm83WQIKuYDDYQLopaCMNmNXVVeYBXfSaCpPSsr+/X4sM9wwVXiQSYX1Er9ezOeL3+9msqN/fFFW2qVTqU4+mpqYQCoX+ar/VM2SIipjmSFVFn6WtJaoHVlZW0NfXxwxTTdCdegQ1KjJUH4VmtdIWUAF5Eo/H2f+BRqPB5OQkXC4XmxkdD6BW4IaV9Hx+fs5mRNXzjjxsB4KG9rv4cYO/6PqH+ANCuD8nsKGMDQAAAABJRU5ErkJggg==",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAC20lEQVR4nO1WPUhyYRS2XzOiBonAssGlQSTadHKL2qKhKYKGakgIl9wchUYjXCSk0CXIIJrEIGhoMfojjSAK+4FKMvq1m9fn47zcV6507buK1eIDF1Hue57nPec856jRVFFFiYAEzV+Sc/wJ+f39PVKpFLLZ7O+KAIDr62vMzc3BbDbj8PAQHx8fv5MNAHh4eIDX60VNTQ0sFgv0ej12dnbw9vb2syIA4OXlBYuLi2hubsbw8DB2d3cRi8VQX1+P9fV1PD09/YwIACzNwWAQBoMBdrsdm5ubebLz83PU1tbC5/OxDCmJgAJUk+dyOUbY29vL6r6yssJ+40Ho8/HxETabDS6XC3d3dwUkclI6J4qiOhGQQGnu7+9nt6f6C4KgeMPPz0+Mj49jZGQEl5eXeYfw8l1dXWFrawvb29u4uLj4XgQkJBIJjI2NoaWlBW63G8/Pz0UP8TMejwdWqxXHx8dMLJUlHA5jamoKRqMRPT09mJycxMnJibIISEgmk5idnUVdXV1BatVkjfqlu7sb0WgUS0tL0Ol0aGtro7P5JxKJsKwpCqCmCwQC7EVSTo2mtnG4CEp3U1MTc42cmJ7p6Wnc3Nx8zQAkkDJS2NDQwKxXUufK4sTjcUao1Wrz5BMTEzg9PS0eExLe39+xt7eHjo4OrK2tlSyCx6LSEeHBwQHOzs6QTqf/HwuyTFDH9vX1MQeUK0IJqg+Loojb21sMDQ1hZmYm7+NSSMoi5+CHKHVOpxMDAwPM1zyQPDAfUISKbkpIoDmwsLCAzs7Ogi5+fX1lpfL7/VheXsbq6ipbUplMprxbK0FORsuHNuLR0RH7vrGxgcbGRuYaepVGNlmNSicf2xUTkclk2IhubW3F6Ogo2tvbv3idJmex5VQREYIgMHuZTKYC4q6uLgwODmJ/f7/y5HJwm9L/gPn5eTgcDjZkQqEQ2yEVTX0xyB1AQvhs/xVytTOgiio0KvAPZBdEKyz2cw4AAAAASUVORK5CYII=",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAACz0lEQVR4nO2VS0hqURiFJTCdiI2CAnPWqOgxCISaVAMRm0gQFUSTZkJQUGiI2ESKRg6cBUKIIEKTGgdFEdQoQiswrKjsZZSSPax1+X86h255yu3Fe+HiBwc8Zz/Wcu+1/61SlSlTIvDOPxVX4q+Iv7294fb2FltbW4jFYri7u+NvQgZQhGPq//r6ikQigfHxcdTW1qKurg6RSAQvLy/FGfiOfGOur6/hdDpRWVlJ7fzMz8+zsXxj8iIJXF5eYm9vD2dnZ0ilUshkMnh8fEQul1M0tb6+ju7ublmcnnA4rGg6L9Qxm81ibm6OJ9Dr9WhqakJ/fz+8Xi8WFxexvb3N5pLJpGzu4eGBxT6Ka7VaHB4eFi5OUOebmxsMDw+jpaWFxU5OTrCxsYFAIICxsTGYTCYWqKqqQnNzMwYHB+HxeGC322Vxg8GA1dVVPD8/ixs4OjpCR0cHrFYrb4ES9K+Pj4+xtrbGez06Ooq2tjbYbDZcXV3J4RM2sLOzwwkeGRnB/f29YugKpWBxggasrKzw/k1OTsqhUwlQtDhBg2iv6afb7S5KXKT/l8F0Zv1+PzQaDUKhkJCBP94CvAfL5XKhpqaGU1zIBB/FqOxGo1FcXFyIFSBCqmZDQ0NobW3liX6aQBImMboDpqam0Nvbi+npab4HhA0kEgm0t7ejp6dHPoI/jaGgxuNxPn70qaKiAmazGefn5+IGdnd3uYhQIZKO4Hd7Su9UDS0Wy29VkFaRVlPYwP7+Pqqrq3kSKkYTExNYWFjA5uYmTk9P+T74DJVbo9Eoi9fX1/NJkvoWLE48PT1xgA4ODng1lpeXMTs7i4GBATQ2NkKn07FIZ2cnHA4HgsEgt6vVatkA1Q+6TySEDHyGwkX1nCZMp9McNCq/FNClpSXMzMygr68PDQ0N6Orqgs/nk9MvtPz5+OJGwRwdXSnxH1GVEiggtZVUvEyZ/4Jfqfo3cUsbAtUAAAAASUVORK5CYII=",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAC7ElEQVR4nO1Xz0sqYRS1Io0gapNSiLtwVeLWVrYQpD/AhRAStHPlKiUqMHIhaEERuk2IWtiiRYuCwFzUJkIowSCCfhAlYqZZap7H/ZgZvh693mhq8HgHBn/g3HPunXvP/VQoGgwIaHRc2cQtFwABpVIJt7e3KBQKrRMAAUQcCoUwNjaGjY0NFIvF1ogAgEqlgt3dXej1eiKE0WjE+fl58wVAAGW7uLjIyMVre3sb7+/vzRUBAZlMBk6nEz09PZIAr9eLcrncmio8Pz8jGAyis7OTkdNrLBZr/jSAw97eniTA4XDg7e2teQLAgYgeHh6wvr4OrVaL/v5+HBwcNIccHKjxaPS2trYwPDyM0dFRHB4e/tGIviUGHPL5PC4vL7GysoLBwUHY7XacnZ19Svy7M9YsAgKq1Sqenp4Y0czMDLq7uzE9PY2bm5svMya8vLywq6aRhAAyGBqxk5MTTE5Oor29HcvLy8hms19mxFdrc3MTCwsL7HHVJKBcLiOZTGJ8fBxtbW0skNzOFn+zs7MDs9mMgYEBBAIB+TsCQtmj0SgbK7fbLZHLTYDK7nK5JGMaGRlBKpWqrQqpVIplYDKZcHp6KutmMXvqmaGhIUkA7Qe+Z2QJKJVKWFtbY49gbm5OViOJBNfX11Cr1ZIASoSmp6ZJAIBEIgGDwQCr1YqLiwvZVcjlckw0fezo6MDq6mrtowiANY7f74dSqcTS0tJfg/Bj6fP5mICJiQnmlnV7wfHxMXQ6HWw2GyvtZ0F44ng8zpyRGo/WMi2rusgJdBPNPRlQb28vIpHIh2DiexpbItNoNLBYLDg6OmKNKK7kbwkg7O/vo6+vD1NTU0in0xBB2YXDYWkLknfQd2LD1k3MgwLQM6RDB5kKZXp/f4/5+Xl0dXXB4/Hg6uqK9Qv5R0NIeYgBafOpVCp28qG1S519d3cnHUAbTsyDAj8+PmJ2dpadeqkCvDU3jViESPL6+tpaYh4fWH/qr5fiP/5F/AKPx0f6ND67AgAAAABJRU5ErkJggg==",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAADD0lEQVR4nNVXS0hqURTVzAiiaGAEUdCgBoJDC2xeUqMoaFJIRDholI0i+gxKiIQGQmCjJIIGNYuIoEEJIkg/kiSogUbSTytCs7Jcj7259/J8r152/cRbcOHe6z17rbPOPvtsFYpvAAIUPwX8gbyTPz094eLiAg8PD/kVAQDJZBKbm5uoqqrC6OgoDg4OkEgk8iMEAK6vr2EymYiIr4aGBvj9fhaWUwEQEI1G0dfXh4KCAklEe3s7YrFYfhx4fHyE3W5HXV2dJKCiogLPz88py5CTJYGQA2R5d3c31Go1C6itrUUkEkkhzMlOgQCa7dHREcxmMwsoLi7G6+tryuzf39/Zrbu7Oyk/si7E7XajpqYGXq/3L+tDoRCsViuGh4exurrKQrImAkIuTE5OYmho6MO1DwQCaG1tZYdKS0uxuLiYnUQFgLe3N+zt7XFw2hUfrf3u7i6qq6v5m8LCQjQ1NeHk5CQzFyCAaoHBYMDW1taHwegdVcmOjg5pp9B1eHiYuYBoNIq5uTn09PR8Gkx8Pz09LZGrVCosLS3JFwAhs30+H2+/cDj8aSCR5ObmBvPz8ygvL2cRwWBQPjmBSNva2rCyssLP6YyhZO3q6oLRaJS/EwAgHo9jeXkZzc3NaQehb+7v79n+s7MzdlAWOeH4+BhlZWU4Pz/n53TH9ff3w+FwSKX6W+QEGkTWUdJRoHSD0Hc7OztobGyU3zdA2PN0/iuVSthsNlxdXX0ZTGxa6JbOjYysTyQSWFtbg06n44o2MDAAl8v1zyaE3o2MjHApptyRZT1BJHh5eYHH44HFYuGqptfrMTExIeXD7wR0v7+/j/r6eumElC1AhBjk8vISCwsLXAWLiorQ29uLjY0NaZaiY5WVlXxA0fJlTC5CJKBjl/rA8fFxlJSUQKvVYmxsDKenp/z77OwsBgcHc9chQcDt7S2cTidaWlq4Pevs7MTU1BTPnpzKivWfQQxO2U1ZPjMzA41Gw1m/vr6e0pzkFBBA+3x7e5vrBFW+nM7+q/zIO7kIifkn/zMSflyA4n/FL4O5PvTxktYkAAAAAElFTkSuQmCC"
    ];
    const MUSICAL_FRAME_MS = 100; // the .ani's original 10 fps

    // Decode the frames once up front so every overlay swap is instant.
    MUSICAL_FRAMES.forEach((frame) => {
      const image = new Image();
      image.src = frame;
    });

    const musicalOverlay = document.createElement('img');
    musicalOverlay.className = 'musical-cursor';
    musicalOverlay.alt = '';
    musicalOverlay.setAttribute('aria-hidden', 'true');
    document.body.appendChild(musicalOverlay);

    let musicalRaf = 0;
    let musicalFrame = -1;
    let musicalStartAt = 0;
    let pointerX = 0;
    let pointerY = 0;
    let pointerInside = false;

    const notePointer = (event) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      pointerInside = true;
    };

    window.addEventListener('pointermove', notePointer, { passive: true });
    document.documentElement.addEventListener('pointerenter', notePointer);
    document.documentElement.addEventListener('pointerleave', () => {
      pointerInside = false;
    });

    const stepMusicalCursor = (now) => {
      musicalRaf = window.requestAnimationFrame(stepMusicalCursor);
      const frame = Math.floor((now - musicalStartAt) / MUSICAL_FRAME_MS) % MUSICAL_FRAMES.length;
      if (frame !== musicalFrame) {
        musicalFrame = frame;
        musicalOverlay.src = MUSICAL_FRAMES[frame];
      }
      musicalOverlay.style.transform = 'translate(' + pointerX + 'px, ' + pointerY + 'px)';
      musicalOverlay.style.visibility = pointerInside ? 'visible' : 'hidden';
    };

    let audio = null;
    let playing = false;
    let volume = 0;
    let fadeToken = 0;

    const setSinging = (on) => {
      if (on) {
        if (!musicalRaf) {
          // Cursors render at one image pixel per device pixel, so match
          // that here (32 device px) regardless of the display's scale.
          const size = Math.round(32 / Math.max(window.devicePixelRatio || 1, 1));
          musicalOverlay.style.width = size + 'px';
          musicalOverlay.style.height = size + 'px';
          musicalFrame = 0;
          musicalStartAt = window.performance.now();
          musicalOverlay.src = MUSICAL_FRAMES[0];
          musicalOverlay.style.transform = 'translate(' + pointerX + 'px, ' + pointerY + 'px)';
          musicalOverlay.style.visibility = pointerInside ? 'visible' : 'hidden';
          musicalRaf = window.requestAnimationFrame(stepMusicalCursor);
        }
      } else if (musicalRaf) {
        window.cancelAnimationFrame(musicalRaf);
        musicalRaf = 0;
      }
      document.documentElement.classList.toggle('is-musical', on);
      excursionTrigger.classList.toggle('is-singing', on);
    };

    const ensureAudio = () => {
      if (!audio) {
        audio = new Audio(excursionTrigger.dataset.audio);
        audio.preload = 'auto';
        audio.addEventListener('ended', () => {
          fadeToken += 1;
          playing = false;
          volume = 0;
          audio.volume = 0;
          setSinging(false);
        });
      }
      return audio;
    };

    const start = () => {
      const source = ensureAudio();
      fadeToken += 1;
      const token = fadeToken;
      playing = true;
      volume = 0;
      source.currentTime = 0;
      source.volume = 0;
      const startedAt = window.performance.now();
      const tick = (now) => {
        if (token !== fadeToken || !playing) {
          return;
        }
        let target = PEAK_VOLUME;
        const sinceStart = now - startedAt;
        if (sinceStart < FADE_IN_MS) {
          target = PEAK_VOLUME * (sinceStart / FADE_IN_MS);
        }
        // The excerpt itself ends mid-note: dissolve to silence over its final
        // TAIL_FADE_MS so the end reads as a fade, not a cut.
        const remainingMs = (source.duration - source.currentTime) * 1000;
        if (source.duration > 0 && remainingMs <= TAIL_FADE_MS) {
          const tail = Math.max(remainingMs / TAIL_FADE_MS, 0);
          target = Math.min(target, PEAK_VOLUME * tail * tail);
        }
        volume = target;
        source.volume = volume;
        window.requestAnimationFrame(tick);
      };
      source
        .play()
        .then(() => {
          if (token === fadeToken && playing) {
            setSinging(true);
            window.requestAnimationFrame(tick);
          }
        })
        .catch(() => {
          // Autoplay blocked or playback failed: the excerpt stays silent.
        });
    };

    const stop = () => {
      if (!playing) {
        return;
      }
      playing = false;
      const source = ensureAudio();
      fadeToken += 1;
      const token = fadeToken;
      const startVolume = volume;
      const startedAt = window.performance.now();
      const fadeDown = (now) => {
        if (token !== fadeToken) {
          return;
        }
        const progress = Math.min((now - startedAt) / FADE_OUT_MS, 1);
        const fade = 1 - progress;
        volume = startVolume * fade * fade;
        source.volume = volume;
        if (progress < 1) {
          window.requestAnimationFrame(fadeDown);
        } else {
          source.pause();
          source.currentTime = 0;
          volume = 0;
          source.volume = 0;
          setSinging(false);
        }
      };
      window.requestAnimationFrame(fadeDown);
    };

    excursionTrigger.addEventListener('mouseenter', start);
    excursionTrigger.addEventListener('mouseleave', stop);
  }

})();
