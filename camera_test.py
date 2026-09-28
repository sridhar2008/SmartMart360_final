import cv2

print("====================================")
print("       WEBCAM DIAGNOSTIC TEST")
print("====================================")

print("Starting camera test...")

# Open webcam using DirectShow on Windows
cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)

print("Camera opened:", cap.isOpened())

if not cap.isOpened():
    print("ERROR: Camera could not be opened.")
    cap.release()
    exit()

# Try to set a normal resolution
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

print("Camera resolution requested: 640 x 480")
print("------------------------------------")

while True:

    ret, frame = cap.read()

    print("Frame received:", ret)

    if ret and frame is not None:

        print("Frame size:", frame.shape)
        print("Pixel value:", frame.mean())

        # Display the frame
        cv2.imshow("WEBCAM TEST", frame)

    else:
        print("ERROR: Camera opened, but no frame received.")
        break

    # Press Q to quit
    if cv2.waitKey(1) & 0xFF == ord("q"):
        print("Q pressed. Stopping camera test...")
        break

print("------------------------------------")
print("Releasing camera...")

cap.release()
cv2.destroyAllWindows()

print("Camera test finished.")