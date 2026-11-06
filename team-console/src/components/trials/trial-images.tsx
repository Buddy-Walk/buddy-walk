import { useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import { noPanoramaReason, storedImage } from "#/lib/trials/display";
import type { TrialDetail } from "#/lib/trials/schema";

function ImageLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/50 px-3 py-2 text-xs font-bold text-muted-foreground">
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

/** The user's photo, which can be turned in quarter steps since phones store it sideways. */
function UserPhoto({ trial }: { trial: TrialDetail }) {
  const src = storedImage(trial.userPhoto);
  const image = useRef<HTMLImageElement>(null);
  const [rotation, setRotation] = useState({ angle: 0, scale: 1 });

  const rotate = () => {
    const angle = (rotation.angle + 90) % 360;
    const { naturalWidth, naturalHeight } = image.current ?? {};
    // Turned sideways, the image is scaled by its aspect ratio so it fills the box's height.
    const scale =
      (angle === 90 || angle === 270) && naturalWidth && naturalHeight
        ? naturalHeight / naturalWidth
        : 1;
    setRotation({ angle, scale });
  };

  return (
    <div className="overflow-hidden rounded-md border">
      <ImageLabel>
        <span>User photo{trial.retryOf ? " (original's)" : ""}</span>
        {src && (
          <Button size="xs" variant="secondary" onClick={rotate}>
            Rotate
          </Button>
        )}
      </ImageLabel>
      {src ? (
        <div className="flex h-50 items-center justify-center overflow-hidden bg-zinc-950">
          <img
            ref={image}
            src={src}
            alt="User photo"
            className="max-h-full max-w-full object-contain transition-transform duration-200"
            style={{ transform: `rotate(${rotation.angle}deg) scale(${rotation.scale})` }}
          />
        </div>
      ) : (
        <Empty>{trial.hasUserPhoto || trial.retryOf ? "Loading photo…" : "No photo"}</Empty>
      )}
    </div>
  );
}

function StreetViewImage({
  title,
  field,
  src,
  missing,
  children,
}: {
  title: string;
  field: "panoramaPhoto" | "destinationPhoto";
  src: string | undefined;
  missing: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-md border">
      <ImageLabel>
        <span>{title}</span>
        {src && (
          <a className="text-primary underline" download={`${field}.jpg`} href={src}>
            Download image
          </a>
        )}
      </ImageLabel>
      {src ? (
        <img src={src} alt={title} loading="lazy" className="block h-auto w-full object-contain" />
      ) : (
        <Empty>{missing}</Empty>
      )}
      {children}
    </div>
  );
}

export function TrialImages({ trial }: { trial: TrialDetail }) {
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-4">
        <UserPhoto key={trial._id} trial={trial} />
      </div>
      <StreetViewImage
        title="Saved panorama"
        field="panoramaPhoto"
        src={storedImage(trial.panoramaPhoto)}
        missing={trial.hasPanorama ? "Loading saved image..." : noPanoramaReason(trial)}
      >
        {trial.panoramaHeadings.length > 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Tile center headings (in stored order):{" "}
            {trial.panoramaHeadings.map((heading) => `${heading}°`).join(", ")}
          </p>
        )}
      </StreetViewImage>
      <StreetViewImage
        title="Destination Street View reference"
        field="destinationPhoto"
        src={storedImage(trial.destinationPhoto)}
        missing={
          trial.hasDestinationPhoto
            ? "Loading saved image..."
            : trial.destinationPhotoStatus || "No separate destination reference saved."
        }
      />
    </>
  );
}
