import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
;

export async function updateSpecficNote(note: string, fvId: string) {

    try{
        const tankRef = doc(db, "fermentors", fvId);
     await updateDoc(tankRef,{specificTankNote:note})
        return {success:true}
    }catch(e){
        return {success:false, error:e}
    }


}